import { CONFIG, SEAT_COUNT, SET_COUNT } from '@mm/shared';
import type {
  CharacterData,
  Context,
  Effect,
  GameResult,
  ReduceResult,
  RoomError,
  RoomEvent,
  RoomState,
  Seat,
  SeatOutcome,
} from './types';

const sec = (s: number) => s * 1000;

const ACTIVE_PHASES = ['INTRO', 'CONFIRM', 'REVEAL', 'TALK', 'VOTE'];

export function characterOf(state: RoomState, seat: Seat): CharacterData {
  const c = state.scenario.characters.find((x) => x.id === seat.characterId);
  if (!c) throw new Error(`キャラクターが見つかりません: ${seat.characterId}`);
  return c;
}

const err = (code: RoomError['code'], message: string): RoomError => ({ code, message });
const wrongPhase = () => err('wrong_phase', '今はその操作ができません');

/**
 * ルームの状態遷移。副作用を持たない純粋関数。設計書 §6.2。
 * 不正な操作のときは state を変えず、error を返す。
 */
export function reduce(prev: RoomState, event: RoomEvent, ctx: Context): ReduceResult {
  if (prev.phase === 'CLOSED') {
    return event.type === 'Tick'
      ? { state: prev, effects: [] }
      : { state: prev, effects: [], error: wrongPhase() };
  }

  const state = structuredClone(prev);
  const effects: Effect[] = [];

  const error = applyEvent(state, event, ctx, effects);
  if (error) return { state: prev, effects: [], error };

  settle(state, ctx, effects);
  return { state, effects };
}

function applyEvent(
  state: RoomState,
  event: RoomEvent,
  ctx: Context,
  effects: Effect[],
): RoomError | null {
  switch (event.type) {
    case 'Tick':
      processIdle(state, ctx, effects);
      return null;

    case 'Close':
      if (state.phase !== 'RESULT') return wrongPhase();
      state.phase = 'CLOSED';
      state.deadlineAt = null;
      return null;

    case 'SwitchToNpc': {
      const seat = state.seats[event.seat];
      if (!seat || seat.kind !== 'human') return err('invalid_seat', '人間の席ではありません');
      if (!ACTIVE_PHASES.includes(state.phase)) return wrongPhase();
      switchSeat(state, seat, ctx, effects);
      return null;
    }

    case 'Ready': {
      if (state.phase !== 'INTRO' && state.phase !== 'CONFIRM') return wrongPhase();
      const seat = state.seats[event.seat];
      if (!seat) return err('invalid_seat', '席が不正です');
      touch(seat, ctx);
      if (!state.ready.includes(seat.index)) state.ready.push(seat.index);
      return null;
    }

    case 'PickCard': {
      if (state.phase !== 'REVEAL') return wrongPhase();
      const seat = state.seats[event.seat];
      if (!seat) return err('invalid_seat', '席が不正です');
      if (state.picks[seat.index] !== undefined) {
        return err('already_done', '公開するカードは選択済みです');
      }
      const card = characterOf(state, seat).cards.find((c) => c.id === event.cardId);
      if (!card || state.revealed.some((r) => r.cardId === card.id)) {
        return err('invalid_card', '公開できないカードです');
      }
      touch(seat, ctx);
      state.picks[seat.index] = card.id;
      return null;
    }

    case 'Chat': {
      if (state.phase !== 'TALK') return wrongPhase();
      const seat = state.seats[event.seat];
      if (!seat) return err('invalid_seat', '席が不正です');
      const body = event.body.trim();
      if (body.length === 0 || body.length > CONFIG.CHAT_MAX_CHARS) {
        return err('invalid_body', `発言は1〜${CONFIG.CHAT_MAX_CHARS}文字で入力してください`);
      }
      touch(seat, ctx);
      state.chat.push({
        id: state.nextChatId++,
        seat: seat.index,
        setNo: state.setNo,
        body,
        at: ctx.now,
      });
      return null;
    }

    case 'AgreeEndTalk': {
      if (state.phase !== 'TALK') return wrongPhase();
      const seat = state.seats[event.seat];
      if (!seat) return err('invalid_seat', '席が不正です');
      touch(seat, ctx);
      if (!state.agreedEnd.includes(seat.index)) state.agreedEnd.push(seat.index);
      return null;
    }

    case 'Vote': {
      if (state.phase !== 'VOTE') return wrongPhase();
      const seat = state.seats[event.seat];
      if (!seat) return err('invalid_seat', '席が不正です');
      if (state.votes[seat.index] !== undefined) return err('already_done', '投票済みです');
      if (
        !Number.isInteger(event.target) ||
        !state.seats[event.target] ||
        event.target === seat.index
      ) {
        return err('invalid_target', '自分以外の席を選んでください');
      }
      touch(seat, ctx);
      state.votes[seat.index] = event.target;
      return null;
    }
  }
}

function touch(seat: Seat, ctx: Context) {
  if (seat.kind === 'human') {
    seat.lastActiveAt = ctx.now;
    seat.warned = false;
  }
}

const humanSeats = (state: RoomState) => state.seats.filter((s) => s.kind === 'human');

/** 自分の番の操作を終え、他の人を待っている状態か（仕様書 5.4 / 設計書 §6.4 の例外） */
function isWaitingOnOthers(state: RoomState, seat: Seat): boolean {
  switch (state.phase) {
    case 'INTRO':
    case 'CONFIRM':
      return state.ready.includes(seat.index);
    case 'REVEAL':
      return state.picks[seat.index] !== undefined;
    case 'TALK':
      return state.agreedEnd.includes(seat.index);
    case 'VOTE':
      return state.votes[seat.index] !== undefined;
    default:
      return false;
  }
}

function processIdle(state: RoomState, ctx: Context, effects: Effect[]) {
  if (!ACTIVE_PHASES.includes(state.phase)) return;
  for (const seat of humanSeats(state)) {
    if (isWaitingOnOthers(state, seat)) {
      // 待っている間は無操作として数えない。次のフェーズで即座に切り替わるのを防ぐ
      seat.lastActiveAt = ctx.now;
      seat.warned = false;
      continue;
    }
    const idle = ctx.now - seat.lastActiveAt;
    if (idle >= sec(CONFIG.IDLE_SWITCH_SEC)) {
      switchSeat(state, seat, ctx, effects);
      if (state.aborted) return;
    } else if (idle >= sec(CONFIG.IDLE_WARN_SEC) && !seat.warned) {
      seat.warned = true;
      effects.push({
        type: 'Warn',
        seat: seat.index,
        switchInSec: Math.ceil((sec(CONFIG.IDLE_SWITCH_SEC) - idle) / 1000),
      });
    }
  }
}

function switchSeat(state: RoomState, seat: Seat, ctx: Context, effects: Effect[]) {
  seat.kind = 'npc';
  seat.switchedAt = ctx.now;
  effects.push({ type: 'SwitchedToNpc', seat: seat.index, userId: seat.userId });

  if (humanSeats(state).length === 0) {
    // 人間が全員いなくなったら、NPCだけで続けずに中断する（AIコスト防止。設計書 §13）
    state.aborted = true;
    state.phase = 'CLOSED';
    state.deadlineAt = null;
    effects.push({ type: 'Aborted' });
  }
}

/** 条件を満たす限り、フェーズを進める。 */
function settle(state: RoomState, ctx: Context, effects: Effect[]) {
  for (let i = 0; i < 10 && advance(state, ctx, effects); i++);
}

function advance(state: RoomState, ctx: Context, effects: Effect[]): boolean {
  const timeUp = state.deadlineAt !== null && ctx.now >= state.deadlineAt;
  const humans = humanSeats(state);

  switch (state.phase) {
    case 'INTRO':
      if (timeUp || humans.every((s) => state.ready.includes(s.index))) {
        state.phase = 'CONFIRM';
        state.ready = [];
        state.deadlineAt = ctx.now + sec(CONFIG.CONFIRM_MAX_SEC);
        const userIds = state.seats.flatMap((s) => (s.userId ? [s.userId] : []));
        effects.push({ type: 'MarkPlayed', userIds });
        return true;
      }
      return false;

    case 'CONFIRM':
      if (timeUp || humans.every((s) => state.ready.includes(s.index))) {
        enterReveal(state, 1, ctx);
        return true;
      }
      return false;

    case 'REVEAL':
      if (timeUp || state.seats.every((s) => state.picks[s.index] !== undefined)) {
        revealAll(state, ctx);
        state.phase = 'TALK';
        state.agreedEnd = [];
        state.deadlineAt = ctx.now + sec(CONFIG.TALK_SEC);
        return true;
      }
      return false;

    case 'TALK':
      if (timeUp || humans.every((s) => state.agreedEnd.includes(s.index))) {
        if (state.setNo < SET_COUNT) {
          enterReveal(state, state.setNo + 1, ctx);
        } else {
          state.phase = 'VOTE';
          state.votes = {};
          state.deadlineAt = ctx.now + sec(CONFIG.VOTE_SEC);
        }
        return true;
      }
      return false;

    case 'VOTE':
      if (timeUp || state.seats.every((s) => state.votes[s.index] !== undefined)) {
        finish(state, ctx, effects);
        return true;
      }
      return false;

    case 'RESULT':
      if (timeUp) {
        state.phase = 'CLOSED';
        state.deadlineAt = null;
        return true;
      }
      return false;

    default:
      return false;
  }
}

function enterReveal(state: RoomState, setNo: number, ctx: Context) {
  state.phase = 'REVEAL';
  state.setNo = setNo;
  state.picks = {};
  state.agreedEnd = [];
  state.deadlineAt = ctx.now + sec(CONFIG.REVEAL_SEC);
}

/** 4人分のカードを同時に公開する。未選択の席は、未公開の手札からランダムに1枚。 */
function revealAll(state: RoomState, ctx: Context) {
  for (const seat of state.seats) {
    const picked = state.picks[seat.index];
    let cardId = picked;
    if (cardId === undefined) {
      const remaining = characterOf(state, seat).cards.filter(
        (c) => !state.revealed.some((r) => r.cardId === c.id),
      );
      cardId = remaining[Math.floor(ctx.rng() * remaining.length)]!.id;
    }
    state.revealed.push({
      setNo: state.setNo,
      seat: seat.index,
      cardId,
      auto: picked === undefined,
    });
  }
  state.picks = {};
}

function finish(state: RoomState, ctx: Context, effects: Effect[]) {
  const tally = Array.from({ length: SEAT_COUNT }, () => 0);
  for (const target of Object.values(state.votes)) {
    if (target !== null && target !== undefined) tally[target] = (tally[target] ?? 0) + 1;
  }
  const max = Math.max(...tally);
  const topSeats = max === 0 ? [] : tally.flatMap((n, i) => (n === max ? [i] : []));

  const culpritSeat = state.seats.find((s) => characterOf(state, s).isCulprit)!.index;
  // 最多得票が犯人ただ1人のときだけ探偵側の勝ち。同数・無投票は犯人の逃げ切り（仕様書 §4.6）
  const winner = topSeats.length === 1 && topSeats[0] === culpritSeat ? 'detectives' : 'culprit';

  const outcomes = state.seats.map((s) => {
    let outcome: SeatOutcome;
    if (s.npcFromStart) outcome = 'npc';
    else if (s.switchedAt !== null) outcome = 'left';
    else {
      const won = winner === 'culprit' ? s.index === culpritSeat : s.index !== culpritSeat;
      outcome = won ? 'win' : 'lose';
    }
    return { seat: s.index, outcome };
  });

  const result: GameResult = { tally, topSeats, culpritSeat, winner, outcomes };
  state.result = result;
  state.phase = 'RESULT';
  state.deadlineAt = ctx.now + sec(CONFIG.RESULT_CLOSE_SEC);
  effects.push({ type: 'Finished', result });
}
