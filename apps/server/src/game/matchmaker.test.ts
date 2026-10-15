import { fileURLToPath } from 'node:url';
import { CONFIG } from '@mm/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../db';
import { env } from '../env';
import { seedScenarios } from '../seed';
import { cleanupTestUsers, createTestUser } from '../test-helpers';
import { Matchmaker } from './matchmaker';
import { RoomManager } from './room-manager';

const db = createDb(env.databaseUrl);
const redis = new Redis(env.redisUrl);

let clock = 1_800_000_000_000;
const advance = (sec: number) => (clock += sec * 1000);
const rooms = new RoomManager({ db, redis, now: () => clock });
const matchmaker = new Matchmaker(db, rooms, { now: () => clock });

let scenarioId = '';
const gameIds: string[] = [];

async function waitingUser(size: number) {
  const userId = await createTestUser(db);
  expect(await matchmaker.enqueue(userId, scenarioId, size)).toBeNull();
  return userId;
}

function roomOf(userId: string) {
  const status = matchmaker.status(userId);
  if (status.status !== 'matched') throw new Error(`マッチしていません: ${status.status}`);
  gameIds.push(status.roomId);
  return rooms.getState(status.roomId)!.state;
}

beforeAll(async () => {
  await seedScenarios(db, fileURLToPath(new URL('../../../../scenarios', import.meta.url)));
  scenarioId = (await db.scenario.findUniqueOrThrow({ where: { slug: '001-yukiyama-sansou' } })).id;
});

afterAll(async () => {
  rooms.shutdown();
  await db.game.deleteMany({ where: { id: { in: gameIds } } });
  // 保存された状態が残ると、次にサーバーを起動したとき復元されてしまう
  for (const id of gameIds) await redis.del(`room:${id}:state`);
  await cleanupTestUsers(db);
  await db.$disconnect();
  redis.disconnect();
});

describe('Matchmaker：待機のタイムアウトと今すぐ開始', () => {
  it('待機の残り秒数が減り、上限に達すると不足分をNPCで補って開始する', async () => {
    const a = await waitingUser(4);
    const b = await waitingUser(4);
    const first = matchmaker.status(a);
    expect(first).toMatchObject({
      status: 'waiting',
      waiting: 2,
      remainingSec: CONFIG.MATCH_WAIT_SEC,
    });

    advance(CONFIG.MATCH_WAIT_SEC - 10);
    await matchmaker.tick();
    expect(matchmaker.status(a)).toMatchObject({ status: 'waiting', remainingSec: 10 });

    advance(10);
    await matchmaker.tick();
    const state = roomOf(a);
    expect(
      state.seats
        .filter((s) => s.kind === 'human')
        .map((s) => s.userId)
        .sort(),
    ).toEqual([a, b].sort());
    expect(state.seats.filter((s) => s.kind === 'npc')).toHaveLength(2);
    expect(roomOf(b)).toBe(state);
  });

  it('待機が上限未満なら、tick しても開始しない', async () => {
    const a = await waitingUser(3);
    advance(CONFIG.MATCH_WAIT_SEC - 1);
    await matchmaker.tick();
    expect(matchmaker.status(a).status).toBe('waiting');
    matchmaker.cancel(a);
  });

  it('「今すぐ開始」は、1人でも始められ、待っている人をまとめて開始する', async () => {
    const a = await waitingUser(4);
    const b = await waitingUser(4);
    expect(await matchmaker.startNow(a)).toBe(true);
    const state = roomOf(b);
    expect(state.seats.filter((s) => s.kind === 'human')).toHaveLength(2);
  });

  it('待機していない人の「今すぐ開始」は何も起こさない', async () => {
    const userId = await createTestUser(db);
    expect(await matchmaker.startNow(userId)).toBe(false);
    expect(matchmaker.status(userId).status).toBe('none');
  });

  it('別の人数指定の待機列は、タイムアウトの影響を受けない', async () => {
    const a = await waitingUser(4);
    advance(CONFIG.MATCH_WAIT_SEC - 5);
    const b = await waitingUser(3); // こちらは待ち始めたばかり
    await matchmaker.tick();
    expect(matchmaker.status(b).status).toBe('waiting');
    advance(5);
    await matchmaker.tick();
    expect(matchmaker.status(a).status).toBe('matched');
    expect(matchmaker.status(b)).toMatchObject({
      status: 'waiting',
      remainingSec: CONFIG.MATCH_WAIT_SEC - 5,
    });
    roomOf(a);
    matchmaker.cancel(b);
  });
});
