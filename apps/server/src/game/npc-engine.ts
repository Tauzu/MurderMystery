import { projectView, type RoomError, type RoomEvent, type RoomState } from '@mm/game-core';
import {
  Budget,
  decidePick,
  pickPersona,
  decideTalk,
  decideVote,
  nextTalkDelayMs,
  type LlmClient,
} from '@mm/npc';
import { CONFIG } from '@mm/shared';

export type Dispatch = (event: RoomEvent) => Promise<RoomError | null>;

interface RoomNpc {
  budget: Budget;
  /** 席 → 次回発言予定（セットが変わったら組み直す） */
  nextTalk: Map<number, { setNo: number; at: number; reactedTo?: number }>;
  /** AI呼び出し中の行動。同じ行動を二重に始めないための印 */
  inFlight: Set<string>;
  /** 席 → 性格（席ごとに最初に決めたものを使い続ける） */
  personas: Map<number, string>;
}

export interface NpcEngineOptions {
  llm: LlmClient;
  now?: () => number;
  rng?: () => number;
  /** 待つ処理。テストでは即座に返す */
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string, error?: unknown) => void;
}

/**
 * NPC席の行動を決めて、ルームへ操作として入力する。設計書 §8。
 * ルームにとってNPCは「少し遅れて操作する参加者」で、特別扱いはしない。
 * step() は同期的に呼べる。AIの応答は待たず、結果が出たら dispatch する。
 */
export class NpcEngine {
  private readonly rooms = new Map<string, RoomNpc>();
  private readonly now: () => number;
  private readonly rng: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: NpcEngineOptions) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? Date.now;
    this.rng = opts.rng ?? Math.random;
  }

  /** 1秒ごとに呼ばれる。 */
  step(roomId: string, state: RoomState, dispatch: Dispatch) {
    if (state.phase === 'CLOSED' || state.aborted) {
      this.rooms.delete(roomId);
      return;
    }
    const npcSeats = state.seats.filter((s) => s.kind === 'npc');
    if (npcSeats.length === 0) return;
    const room = this.roomOf(roomId);

    for (const seat of npcSeats) {
      if (state.phase === 'REVEAL' && state.picks[seat.index] === undefined) {
        this.once(room, `pick:${state.setNo}:${seat.index}`, async () => {
          const d = await decidePick(
            this.deps(room, seat.index),
            projectView(state, seat.index, this.now()),
          );
          await dispatch({ type: 'PickCard', seat: seat.index, cardId: d.cardId });
        });
      } else if (state.phase === 'VOTE' && state.votes[seat.index] === undefined) {
        this.once(room, `vote:${seat.index}`, async () => {
          const d = await decideVote(
            this.deps(room, seat.index),
            projectView(state, seat.index, this.now()),
          );
          await dispatch({ type: 'Vote', seat: seat.index, target: d.target });
        });
      } else if (state.phase === 'TALK') {
        this.stepTalk(room, state, seat.index, dispatch);
      }
    }
  }

  forget(roomId: string) {
    this.rooms.delete(roomId);
  }

  private stepTalk(room: RoomNpc, state: RoomState, seat: number, dispatch: Dispatch) {
    const now = this.now();
    const view = () => projectView(state, seat, now);
    const schedule = room.nextTalk.get(seat);
    if (!schedule || schedule.setNo !== state.setNo) {
      room.nextTalk.set(seat, { setNo: state.setNo, at: now + this.delay(room, view()) });
      return;
    }
    const last = view()
      .chat.filter((m) => m.setNo === state.setNo)
      .at(-1);

    // 次の発言を待っている間に相手が話しかけてきたら、予定を前倒しして返事をする（設計書 §8.2）。
    // 予定は自分の発言の直後に組むため、相手の発言を見てから組み直さないと、30〜60秒待たせてしまう。
    if (last && last.seat !== seat && schedule.reactedTo !== last.id) {
      schedule.reactedTo = last.id;
      schedule.at = Math.min(schedule.at, last.at + this.delay(room, view()));
    }
    if (now < schedule.at) return;

    // 直前に誰かが話していたら、重ならないように少しずらす（設計書 §8.2）
    if (last && now - last.at < CONFIG.NPC_TALK_COLLISION_SEC * 1000) {
      schedule.at = now + CONFIG.NPC_TALK_COLLISION_SEC * 1000;
      return;
    }
    // 自分の発言に相手がまだ返していないときは、しばらく待つ（同じ話の繰り返しを避ける）
    if (last && last.seat === seat && now - last.at < CONFIG.NPC_FOLLOWUP_WAIT_SEC * 1000) {
      schedule.at = last.at + CONFIG.NPC_FOLLOWUP_WAIT_SEC * 1000;
      return;
    }

    this.once(room, `talk:${seat}`, async () => {
      // 考えている間は「入力中…」を出す。生成が早く終わっても、人間らしい間を空けてから発言する（設計書 §8.7）
      await dispatch({ type: 'NpcTyping', seat, typing: true });
      try {
        const [min, max] = CONFIG.NPC_TYPING_SEC;
        const typingMs = (min + this.rng() * (max - min)) * 1000;
        // 古い状態で発言しないよう、呼び出す直前の状態を使う
        const [d] = await Promise.all([
          decideTalk(this.deps(room, seat), view()),
          this.sleep(typingMs),
        ]);
        const after = this.now();
        room.nextTalk.set(seat, { setNo: state.setNo, at: after + this.delay(room, view()) });
        if (d) await dispatch({ type: 'Chat', seat, body: d.say });
      } finally {
        await dispatch({ type: 'NpcTyping', seat, typing: false });
      }
    });
  }

  private delay(room: RoomNpc, view: ReturnType<typeof projectView>) {
    return nextTalkDelayMs({ view, rng: this.rng, budgetSlow: room.budget.slow });
  }

  private deps(room: RoomNpc, seat: number) {
    return {
      llm: this.opts.llm,
      budget: room.budget,
      persona: this.personaOf(room, seat),
      rng: this.rng,
      onFallback: (label: string, reason: string) =>
        this.opts.log?.(
          `NPC(${label})が定型文に切り替え：${reason}（予算 ${room.budget.usedTokens} / ${room.budget.limit}）`,
        ),
      onError: (label: string, e: unknown) => this.opts.log?.(`NPC(${label})のAI呼び出しに失敗`, e),
    };
  }

  private personaOf(room: RoomNpc, seat: number): string {
    let persona = room.personas.get(seat);
    if (persona === undefined) {
      persona = pickPersona(this.rng).text;
      room.personas.set(seat, persona);
    }
    return persona;
  }

  private roomOf(roomId: string): RoomNpc {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        budget: new Budget(CONFIG.NPC_BUDGET_TOKENS),
        nextTalk: new Map(),
        inFlight: new Set(),
        personas: new Map(),
      };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  /** 同じキーの処理が走っている間は始めない。失敗は握りつぶさずログに残す。 */
  private once(room: RoomNpc, key: string, task: () => Promise<void>) {
    if (room.inFlight.has(key)) return;
    room.inFlight.add(key);
    void task()
      .catch((e) => this.opts.log?.(`NPCの行動に失敗: ${key}`, e))
      .finally(() => room.inFlight.delete(key));
  }
}
