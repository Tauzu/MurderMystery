import { fileURLToPath } from 'node:url';
import { CONFIG } from '@mm/shared';
import type { RoomEvent } from '@mm/game-core';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../db';
import { env } from '../env';
import { seedScenarios } from '../seed';
import { cleanupTestUsers, createTestUser } from '../test-helpers';
import { RoomManager, type RoomUpdate } from './room-manager';

const db = createDb(env.databaseUrl);
const redis = new Redis(env.redisUrl);

let clock = 1_800_000_000_000;
const advance = (sec: number) => (clock += sec * 1000);
const newManager = () => new RoomManager({ db, redis, now: () => clock });
const manager = newManager();

let scenarioId = '';
const gameIds: string[] = [];

async function startGame(humanCount: number, mgr = manager) {
  const userIds: string[] = [];
  for (let i = 0; i < humanCount; i++) userIds.push(await createTestUser(db));
  const participants = [
    ...userIds.map((userId) => ({ kind: 'human' as const, userId })),
    ...Array.from({ length: 4 - humanCount }, () => ({ kind: 'npc' as const })),
  ];
  const roomId = await mgr.createRoom(scenarioId, participants);
  gameIds.push(roomId);
  return { roomId, userIds };
}

async function send(roomId: string, event: RoomEvent, mgr = manager) {
  const error = await mgr.dispatch(roomId, event);
  if (error) throw new Error(`${event.type}: ${error.code}`);
}

const seats = [0, 1, 2, 3];

beforeAll(async () => {
  await seedScenarios(db, fileURLToPath(new URL('../../../../scenarios', import.meta.url)));
  scenarioId = (await db.scenario.findUniqueOrThrow({ where: { slug: '001-yukiyama-sansou' } })).id;
});

afterAll(async () => {
  manager.shutdown();
  await db.game.deleteMany({ where: { id: { in: gameIds } } });
  await cleanupTestUsers(db);
  await db.$disconnect();
  redis.disconnect();
});

describe('RoomManager：全員人間で最後まで遊ぶ', () => {
  it('結果とログがDBに保存され、全員がプレイ済みになる', async () => {
    const { roomId, userIds } = await startGame(4);
    const updates: RoomUpdate[] = [];
    manager.subscribe(roomId, (u) => updates.push(u));

    for (const seat of seats) await send(roomId, { type: 'Ready', seat });
    expect(manager.getState(roomId)?.state.phase).toBe('CONFIRM');
    // 確認フェーズに入った時点で、プレイ済みになっている
    expect(await db.playedScenario.count({ where: { scenarioId, userId: { in: userIds } } })).toBe(
      4,
    );

    for (const seat of seats) await send(roomId, { type: 'Ready', seat });
    for (let set = 1; set <= 3; set++) {
      for (const seat of seats) {
        const { state } = manager.getState(roomId)!;
        const character = state.scenario.characters.find(
          (c) => c.id === state.seats[seat]!.characterId,
        )!;
        const card = character.cards.find((c) => !state.revealed.some((r) => r.cardId === c.id))!;
        await send(roomId, { type: 'PickCard', seat, cardId: card.id });
      }
      await send(roomId, { type: 'Chat', seat: set % 4, body: `セット${set}の発言` });
      for (const seat of seats) await send(roomId, { type: 'AgreeEndTalk', seat });
    }
    expect(manager.getState(roomId)?.state.phase).toBe('VOTE');
    for (const seat of seats) await send(roomId, { type: 'Vote', seat, target: (seat + 1) % 4 });

    // 結果が出た時点でDBに書かれる
    const game = await db.game.findUniqueOrThrow({
      where: { id: roomId },
      include: {
        participations: true,
        chatMessages: true,
        revealedCards: true,
        votes: true,
      },
    });
    expect(game.status).toBe('finished');
    expect(game.finishedAt).not.toBeNull();
    expect(game.participations).toHaveLength(4);
    expect(game.participations.every((p) => p.outcome === 'win' || p.outcome === 'lose')).toBe(
      true,
    );
    expect(game.chatMessages).toHaveLength(3);
    expect(game.revealedCards).toHaveLength(12);
    expect(game.votes).toHaveLength(4);
    expect(game.result).toMatchObject({ winner: 'culprit' }); // 全員が別々の人に1票ずつ = 同数

    expect(updates.some((u) => u.effects.some((e) => e.type === 'Finished'))).toBe(true);
    // seq は単調に増える
    expect(updates.map((u) => u.seq)).toEqual([...updates.map((u) => u.seq)].sort((a, b) => a - b));

    // 結果を2回保存しない：Close しても Game は変わらない
    await send(roomId, { type: 'Close' });
    expect(manager.getState(roomId)).toBeNull(); // 閉じたルームはメモリから消える
    expect(await db.chatMessage.count({ where: { gameId: roomId } })).toBe(3);
  });

  it('不正な操作はエラーを返し、状態は変わらない', async () => {
    const { roomId } = await startGame(4);
    const before = manager.getState(roomId)!;
    const error = await manager.dispatch(roomId, { type: 'Vote', seat: 0, target: 1 });
    expect(error?.code).toBe('wrong_phase');
    expect(manager.getState(roomId)?.seq).toBe(before.seq);
  });

  it('存在しないルームへの操作はエラーになる', async () => {
    const error = await manager.dispatch('00000000-0000-4000-8000-000000000000', { type: 'Tick' });
    expect(error).not.toBeNull();
  });

  it('同時に届いた操作も、1つずつ順に処理される', async () => {
    const { roomId } = await startGame(4);
    await Promise.all(seats.map((seat) => send(roomId, { type: 'Ready', seat })));
    expect(manager.getState(roomId)?.state.phase).toBe('CONFIRM');
    expect(manager.getState(roomId)?.state.ready).toEqual([]);
  });
});

describe('RoomManager：時間の経過', () => {
  it('無操作のまま時間が経つと、警告のあとNPCに切り替わる', async () => {
    const { roomId } = await startGame(2);
    const effects: string[] = [];
    manager.subscribe(roomId, (u) => effects.push(...u.effects.map((e) => e.type)));

    // 席0・席1とも無操作
    advance(CONFIG.IDLE_WARN_SEC);
    await manager.tickAll();
    expect(effects.filter((t) => t === 'Warn')).toHaveLength(2);

    advance(CONFIG.IDLE_SWITCH_SEC - CONFIG.IDLE_WARN_SEC);
    await manager.tickAll();
    expect(effects).toContain('SwitchedToNpc');
    expect(effects).toContain('Aborted');
  });

  it('人間が全員いなくなると中断として保存され、メモリから消える', async () => {
    const { roomId, userIds } = await startGame(1);
    advance(CONFIG.IDLE_SWITCH_SEC);
    await manager.tickAll();

    expect(manager.getState(roomId)).toBeNull();
    const game = await db.game.findUniqueOrThrow({
      where: { id: roomId },
      include: { participations: { orderBy: { seat: 'asc' } } },
    });
    expect(game.status).toBe('aborted');
    const human = game.participations.find((p) => p.userId === userIds[0])!;
    expect(human.outcome).toBe('left');
    expect(human.switchedToNpcAt).not.toBeNull();
    expect(game.participations.filter((p) => p.outcome === 'npc')).toHaveLength(3);
    // 確認フェーズに入る前の中断でも、再挑戦は…（まだ導入のみなのでプレイ済みにはならない）
    expect(await db.playedScenario.count({ where: { userId: userIds[0] } })).toBe(0);
  });

  it('自動で進む時間を過ぎると、全員が自動公開・自動進行で投票まで進む', async () => {
    const { roomId } = await startGame(4);
    advance(CONFIG.INTRO_MAX_SEC);
    await manager.tickAll(); // CONFIRM
    // 全員が無操作で切り替わらないよう、各フェーズの直前に全員が操作する
    const touch = async () => {
      for (const seat of seats) {
        await manager.dispatch(roomId, { type: 'Ready', seat });
      }
    };
    await touch();
    expect(manager.getState(roomId)?.state.phase).toBe('REVEAL');
    for (let set = 1; set <= 3; set++) {
      advance(CONFIG.REVEAL_SEC);
      await manager.tickAll(); // 自動公開 → TALK
      advance(CONFIG.TALK_SEC - 1);
      for (const seat of seats) await send(roomId, { type: 'Chat', seat, body: 'うーん' });
      advance(1);
      await manager.tickAll();
    }
    const { state } = manager.getState(roomId)!;
    expect(state.phase).toBe('VOTE');
    expect(state.revealed.filter((r) => r.auto)).toHaveLength(12);
  });
});

describe('RoomManager：ユーザーとルームの対応', () => {
  it('進行中のルームだけが見つかり、結果が出たあとは見つからない', async () => {
    const { roomId, userIds } = await startGame(4);
    expect(manager.findRoomByUser(userIds[0]!)).toBe(roomId);
    expect(manager.findRoomByUser('00000000-0000-4000-8000-000000000000')).toBeNull();

    for (const seat of seats) await send(roomId, { type: 'Ready', seat });
    for (const seat of seats) await send(roomId, { type: 'Ready', seat });
    advance(CONFIG.REVEAL_SEC);
    await manager.tickAll();
    // 以降は結果まで時間で進める。途中で無操作切替にならないよう毎回操作する
    for (let set = 1; set <= 3; set++) {
      if (set > 1) {
        advance(CONFIG.REVEAL_SEC);
        await manager.tickAll();
      }
      for (const seat of seats) await send(roomId, { type: 'Chat', seat, body: 'どうも' });
      for (const seat of seats) await send(roomId, { type: 'AgreeEndTalk', seat });
    }
    for (const seat of seats) await send(roomId, { type: 'Vote', seat, target: (seat + 1) % 4 });
    expect(manager.getState(roomId)?.state.phase).toBe('RESULT');
    expect(manager.findRoomByUser(userIds[0]!)).toBeNull();
  });
});

describe('RoomManager：再起動からの復元', () => {
  it('Redis のスナップショットから、同じ状態のルームを復元できる', async () => {
    const { roomId } = await startGame(4);
    for (const seat of seats) await send(roomId, { type: 'Ready', seat });
    const original = manager.getState(roomId)!;

    const restarted = newManager();
    const restored = await restarted.restoreAll();
    expect(restored).toBeGreaterThanOrEqual(1);
    expect(restarted.getState(roomId)?.state).toEqual(original.state);
    expect(restarted.getState(roomId)?.seq).toBe(original.seq);

    // 復元後も続きから進められる
    for (const seat of seats) await send(roomId, { type: 'Ready', seat }, restarted);
    expect(restarted.getState(roomId)?.state.phase).toBe('REVEAL');
    restarted.shutdown();
  });
});

describe('RoomManager：NPC席の自動行動', () => {
  it('人間が全員行動済みなら、少し待つだけでカード公開と投票が進む', async () => {
    const { roomId } = await startGame(2);
    for (const seat of [0, 1]) await send(roomId, { type: 'Ready', seat });
    for (const seat of [0, 1]) await send(roomId, { type: 'Ready', seat });
    expect(manager.getState(roomId)?.state.phase).toBe('REVEAL');

    for (const seat of [0, 1]) {
      const { state } = manager.getState(roomId)!;
      const character = state.scenario.characters.find(
        (c) => c.id === state.seats[seat]!.characterId,
      )!;
      await send(roomId, { type: 'PickCard', seat, cardId: character.cards[0]!.id });
    }
    // 直後はまだ待つ。NPC席の行動を待たずにタイムアウトまで放置されないことを確認する
    await manager.tickAll();
    expect(manager.getState(roomId)?.state.phase).toBe('REVEAL');
    advance(CONFIG.NPC_FALLBACK_DELAY_SEC + 1);
    await manager.tickAll();
    expect(manager.getState(roomId)?.state.phase).toBe('TALK');
  });
});
