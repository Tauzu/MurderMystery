import { fileURLToPath } from 'node:url';
import type { LlmClient, LlmRequest } from '@mm/npc';
import { CONFIG } from '@mm/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../db';
import { env } from '../env';
import { seedScenarios } from '../seed';
import { cleanupTestUsers, createTestUser } from '../test-helpers';
import { NpcEngine } from './npc-engine';
import { RoomManager } from './room-manager';

const db = createDb(env.databaseUrl);
const redis = new Redis(env.redisUrl);

let clock = 1_800_000_000_000;
const advance = (sec: number) => (clock += sec * 1000);

/** どの席に何を聞かれても決まった答えを返すAI。呼び出しの内容は記録する。 */
/** 自分の過去の発言との重複検査に引っかからないよう、内容の違う発言を順に返す */
const SAYS = [
  '昨夜の行動を順に教えてください。',
  'デキャンタの蓋が外れていた件が気になります。',
  '鍵を拾った時刻をもう一度確認させてください。',
  '電話の記録には、前後の空白がありますね。',
  '書斎の扉が開いていたのは不自然です。',
  '誰が最後にラウンジを出ましたか。',
  '医療用の瓶のようなものが見つかっています。',
  '廊下の金属音について詳しく聞かせてください。',
];

function fakeLlm(mode: 'ok' | 'down' = 'ok') {
  const calls: LlmRequest[] = [];
  const llm: LlmClient = {
    async complete(req) {
      calls.push(req);
      if (mode === 'down') throw new Error('API down');
      const text = req.user.includes('次の発言を1つ')
        ? `{"say": "${SAYS[calls.length % SAYS.length]}"}`
        : req.user.includes('投票の時間')
          ? '{"target": 0, "reason": "なんとなく"}'
          : `{"cardId": "${/\[(\w[\w-]*)\]（未公開）/.exec(req.user)?.[1] ?? ''}"}`;
      return { text, inputTokens: 2000, outputTokens: 40 };
    },
  };
  return { llm, calls };
}

function managerWith(llm: LlmClient, idle: { idleSwitchSec?: number; idleWarnSec?: number } = {}) {
  const engine = new NpcEngine({ llm, now: () => clock, rng: () => 0.5, sleep: async () => {} });
  return new RoomManager({ db, redis, now: () => clock, rng: () => 0.5, npc: engine, ...idle });
}

let scenarioId = '';
const gameIds: string[] = [];
const managers: RoomManager[] = [];

async function startOneHumanGame(mgr: RoomManager) {
  const userId = await createTestUser(db);
  const roomId = await mgr.createRoom(scenarioId, [
    { kind: 'human', userId },
    { kind: 'npc' },
    { kind: 'npc' },
    { kind: 'npc' },
  ]);
  gameIds.push(roomId);
  managers.push(mgr);
  return roomId;
}

/** 非同期のAI処理が終わるまで待つ */
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeAll(async () => {
  await seedScenarios(db, fileURLToPath(new URL('../../../../scenarios', import.meta.url)));
  scenarioId = (await db.scenario.findUniqueOrThrow({ where: { slug: '001-yukiyama-sansou' } })).id;
});

afterAll(async () => {
  managers.forEach((m) => m.shutdown());
  await db.game.deleteMany({ where: { id: { in: gameIds } } });
  // 保存された状態が残ると、次にサーバーを起動したとき復元されてしまう
  for (const id of gameIds) await redis.del(`room:${id}:state`);
  await cleanupTestUsers(db);
  await db.$disconnect();
  redis.disconnect();
});

describe('NpcEngine：NPC席がAIで行動する', () => {
  it('カード公開・発言・投票をAIの判断で行い、最後まで進む', async () => {
    const { llm, calls } = fakeLlm();
    const mgr = managerWith(llm);
    const roomId = await startOneHumanGame(mgr);
    const phase = () => mgr.getState(roomId)!.state.phase;
    const state = () => mgr.getState(roomId)!.state;
    const ready = async () => mgr.dispatch(roomId, { type: 'Ready', seat: 0 });

    await ready();
    await ready();
    expect(phase()).toBe('REVEAL');

    for (let set = 1; set <= 3; set++) {
      // 人間が公開カードを選ぶと、NPC席もAIの判断で選び、全員が揃って会話へ進む
      const mine = state().scenario.characters.find((c) => c.id === state().seats[0]!.characterId)!;
      const open = mine.cards.find((c) => !state().revealed.some((r) => r.cardId === c.id))!;
      await mgr.dispatch(roomId, { type: 'PickCard', seat: 0, cardId: open.id });
      await mgr.tickAll();
      await settle();
      await mgr.tickAll();
      expect(phase()).toBe('TALK');
      expect(state().revealed.filter((r) => r.setNo === set)).toHaveLength(4);

      // 発言の予定が決まり、時間が来るとNPCが話す
      const before = state().chat.length;
      await mgr.tickAll();
      advance(CONFIG.NPC_TALK_INTERVAL_SEC[1] + 1);
      await mgr.tickAll();
      await settle();
      const spoken = state().chat.slice(before);
      expect(spoken.length).toBeGreaterThan(0);
      expect(spoken.every((m) => m.seat !== 0 && SAYS.includes(m.body))).toBe(true);

      await mgr.dispatch(roomId, { type: 'AgreeEndTalk', seat: 0 });
      await mgr.tickAll();
    }

    expect(phase()).toBe('VOTE');
    await mgr.dispatch(roomId, { type: 'Vote', seat: 0, target: 1 });
    await mgr.tickAll();
    await settle();
    await mgr.tickAll();
    expect(phase()).toBe('RESULT');
    // NPC席は自分以外に投票している
    const votes = state().votes;
    for (const seat of [1, 2, 3]) expect(votes[seat]).not.toBe(seat);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('発言を考えている間だけ「入力中」になり、発言すると消える', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { llm } = fakeLlm();
    const slow: LlmClient = {
      async complete(req) {
        if (req.user.includes('次の発言を1つ')) await gate;
        return llm.complete(req);
      },
    };
    const mgr = managerWith(slow, { idleSwitchSec: 100_000, idleWarnSec: 99_000 });
    const roomId = await startOneHumanGame(mgr);
    const state = () => mgr.getState(roomId)!.state;
    await mgr.dispatch(roomId, { type: 'Ready', seat: 0 });
    await mgr.dispatch(roomId, { type: 'Ready', seat: 0 });
    const mine = state().scenario.characters.find((c) => c.id === state().seats[0]!.characterId)!;
    await mgr.dispatch(roomId, { type: 'PickCard', seat: 0, cardId: mine.cards[0]!.id });
    await mgr.tickAll();
    await settle();
    await mgr.tickAll();
    expect(state().phase).toBe('TALK');

    await mgr.tickAll();
    advance(CONFIG.NPC_TALK_INTERVAL_SEC[1] + 1);
    await mgr.tickAll();
    await settle();
    expect(state().typing).toContain(1); // 席0の相手（席1）が考え中

    release();
    await settle();
    await settle();
    expect(state().typing).not.toContain(1);
    expect(state().chat.some((m) => m.seat === 1)).toBe(true);
  });

  it('相手が返事をしないうちは、同じNPCが続けて話さない', async () => {
    const { llm } = fakeLlm();
    // 人間が黙ったままでも、無操作で切り替わらないよう長くしておく
    const mgr = managerWith(llm, { idleSwitchSec: 100_000, idleWarnSec: 99_000 });
    const roomId = await startOneHumanGame(mgr);
    const state = () => mgr.getState(roomId)!.state;
    await mgr.dispatch(roomId, { type: 'Ready', seat: 0 });
    await mgr.dispatch(roomId, { type: 'Ready', seat: 0 });
    const mine = state().scenario.characters.find((c) => c.id === state().seats[0]!.characterId)!;
    await mgr.dispatch(roomId, { type: 'PickCard', seat: 0, cardId: mine.cards[0]!.id });
    await mgr.tickAll();
    await settle();
    await mgr.tickAll();
    expect(state().phase).toBe('TALK');

    // セット1の席0の相手は席1。席0（人間）は黙ったまま
    const fromSeat1 = () => state().chat.filter((m) => m.seat === 1).length;
    await mgr.tickAll();
    advance(CONFIG.NPC_TALK_INTERVAL_SEC[1] + 1);
    await mgr.tickAll();
    await settle();
    expect(fromSeat1()).toBe(1);

    advance(CONFIG.NPC_TALK_INTERVAL_SEC[1] + 1); // 通常の間隔は過ぎたが、まだ待つ
    await mgr.tickAll();
    await settle();
    expect(fromSeat1()).toBe(1);

    advance(CONFIG.NPC_FOLLOWUP_WAIT_SEC);
    await mgr.tickAll();
    await mgr.tickAll();
    await settle();
    expect(fromSeat1()).toBe(2);
  });

  it('NPCに渡したプロンプトに、他の席の状況文・未公開カードは含まれない', async () => {
    const { llm, calls } = fakeLlm();
    const mgr = managerWith(llm);
    const roomId = await startOneHumanGame(mgr);
    await mgr.dispatch(roomId, { type: 'Ready', seat: 0 });
    await mgr.dispatch(roomId, { type: 'Ready', seat: 0 });
    await mgr.tickAll();
    await settle();

    const { state } = mgr.getState(roomId)!;
    const asked = calls.map((c) => c.user);
    expect(asked.length).toBeGreaterThanOrEqual(3);
    for (const seat of [1, 2, 3]) {
      const own = state.scenario.characters.find((c) => c.id === state.seats[seat]!.characterId)!;
      const prompt = asked.find((u) => u.includes(own.situationText))!;
      expect(prompt).toBeDefined();
      for (const other of state.scenario.characters.filter((c) => c.id !== own.id)) {
        expect(prompt).not.toContain(other.situationText);
        for (const card of other.cards) {
          // 犯人は、他人の手札にある捏造カードを知っている（仕様書 §4.3.1）
          if (card.isFabricated && own.isCulprit) continue;
          expect(prompt).not.toContain(card.body);
        }
      }
    }
  });

  it('AIが落ちていても、ランダム選択と定型の振る舞いでゲームが止まらない', async () => {
    const { llm } = fakeLlm('down');
    const mgr = managerWith(llm);
    const roomId = await startOneHumanGame(mgr);
    const state = () => mgr.getState(roomId)!.state;
    await mgr.dispatch(roomId, { type: 'Ready', seat: 0 });
    await mgr.dispatch(roomId, { type: 'Ready', seat: 0 });

    const mine = state().scenario.characters.find((c) => c.id === state().seats[0]!.characterId)!;
    await mgr.dispatch(roomId, { type: 'PickCard', seat: 0, cardId: mine.cards[0]!.id });
    await mgr.tickAll();
    await settle();
    await mgr.tickAll();
    expect(state().phase).toBe('TALK');

    // 発言はAI失敗のため見送られ、エラーにならない
    await mgr.tickAll();
    advance(CONFIG.NPC_TALK_INTERVAL_SEC[1] + 1);
    await mgr.tickAll();
    await settle();
    expect(state().chat).toHaveLength(0);
    expect(state().phase).toBe('TALK');
  });

  it('予算を使い切ると、AIを呼ばず定型文で話す', async () => {
    const { llm, calls } = fakeLlm();
    const engine = new NpcEngine({ llm, now: () => clock, rng: () => 0.5, sleep: async () => {} });
    const mgr = new RoomManager({ db, redis, now: () => clock, rng: () => 0.5, npc: engine });
    const roomId = await startOneHumanGame(mgr);
    const state = () => mgr.getState(roomId)!.state;
    await mgr.dispatch(roomId, { type: 'Ready', seat: 0 });
    await mgr.dispatch(roomId, { type: 'Ready', seat: 0 });
    const mine = state().scenario.characters.find((c) => c.id === state().seats[0]!.characterId)!;
    await mgr.dispatch(roomId, { type: 'PickCard', seat: 0, cardId: mine.cards[0]!.id });
    await mgr.tickAll();
    await settle();
    await mgr.tickAll();
    expect(state().phase).toBe('TALK');

    // 予算を使い切った状態にする
    (
      engine as unknown as { rooms: Map<string, { budget: { add(a: number, b: number): void } }> }
    ).rooms
      .get(roomId)!
      .budget.add(CONFIG.NPC_BUDGET_TOKENS, 0);
    const callsBefore = calls.length;

    await mgr.tickAll();
    advance(CONFIG.NPC_TALK_INTERVAL_SEC[1] * 2 + 1);
    await mgr.tickAll();
    await settle();
    expect(calls.length).toBe(callsBefore);
    expect(state().chat.length).toBeGreaterThan(0);
  });
});
