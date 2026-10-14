import {
  characterOf,
  createRoom,
  reduce,
  type Effect,
  type Participant,
  type RoomError,
  type RoomEvent,
  type RoomState,
} from '@mm/game-core';
import { CONFIG } from '@mm/shared';
import type { Redis } from 'ioredis';
import type { Db } from '../db';
import { loadScenarioData } from './loader';
import type { NpcEngine } from './npc-engine';
import { createGameRecords, finishGame, markPlayed } from './persist';

export interface RoomUpdate {
  state: RoomState;
  seq: number;
  effects: Effect[];
}

export type RoomListener = (update: RoomUpdate) => void;

interface Room {
  id: string;
  scenarioId: string;
  state: RoomState;
  seq: number;
  participationIds: string[];
  /** 結果（または中断）をDBに書き込み済みか */
  recorded: boolean;
  listeners: Set<RoomListener>;
  /** 同じルームへの操作を1つずつ処理するための列 */
  queue: Promise<unknown>;
}

export interface RoomManagerOptions {
  db: Db;
  redis: Redis;
  now?: () => number;
  rng?: () => number;
  /** 1秒ごとに全ルームへ Tick を送る。本番で有効にし、テストでは手動で tick() を呼ぶ */
  autoTick?: boolean;
  /** NPC席の行動を決めるエンジン。無ければ、カード公開と投票はランダムに行う */
  npc?: NpcEngine;
  /** 無操作でNPCに切り替えるまでの秒数（省略時は CONFIG の値）。テストプレイで延ばす用 */
  idleSwitchSec?: number;
  idleWarnSec?: number;
}

const SNAPSHOT_TTL_SEC = 60 * 60 * 2;
const snapshotKey = (id: string) => `room:${id}:state`;

/**
 * 進行中のルームを保持し、操作の適用・タイマー・保存を担う。設計書 §4・§6。
 * ゲームのルールは game-core に任せ、ここでは時間と入出力だけを扱う。
 */
export class RoomManager {
  private rooms = new Map<string, Room>();
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly rng: () => number;

  constructor(private readonly opts: RoomManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.rng = opts.rng ?? Math.random;
    if (opts.autoTick) {
      this.timer = setInterval(() => void this.tickAll(), 1000);
      this.timer.unref();
    }
  }

  /** ルームを作り、ゲームを開始する。ルームID（Game.id）を返す。 */
  async createRoom(scenarioId: string, participants: Participant[]): Promise<string> {
    const { db } = this.opts;
    const scenario = await loadScenarioData(db, scenarioId);
    const state = createRoom({ scenario: scenario.data, participants }, this.ctx());
    const { gameId, participationIds } = await createGameRecords(
      db,
      scenarioId,
      scenario.version,
      state,
    );
    const room: Room = {
      id: gameId,
      scenarioId,
      state,
      seq: 1,
      participationIds,
      recorded: false,
      listeners: new Set(),
      queue: Promise.resolve(),
    };
    this.rooms.set(gameId, room);
    await this.saveSnapshot(room);
    return gameId;
  }

  private ctx() {
    const { idleSwitchSec, idleWarnSec } = this.opts;
    return { now: this.now(), rng: this.rng, idleSwitchSec, idleWarnSec };
  }

  getState(roomId: string): { state: RoomState; seq: number } | null {
    const room = this.rooms.get(roomId);
    return room ? { state: room.state, seq: room.seq } : null;
  }

  /**
   * そのユーザーが人間として参加中（結果が出る前）のルームを返す。
   * 結果表示中や、NPCに切り替わったあとは含めない（次のゲームを始められるようにする）。
   */
  findRoomByUser(userId: string): string | null {
    for (const room of this.rooms.values()) {
      const playing = room.state.phase !== 'RESULT' && room.state.phase !== 'CLOSED';
      if (playing && room.state.seats.some((s) => s.userId === userId && s.kind === 'human')) {
        return room.id;
      }
    }
    return null;
  }

  /** 状態の変化を受け取る。戻り値で購読を解除する。 */
  subscribe(roomId: string, listener: RoomListener): (() => void) | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    room.listeners.add(listener);
    return () => room.listeners.delete(listener);
  }

  /** 操作を適用する。不正な操作ならエラーを返し、状態は変えない。 */
  dispatch(roomId: string, event: RoomEvent): Promise<RoomError | null> {
    const room = this.rooms.get(roomId);
    if (!room) {
      return Promise.resolve({ code: 'wrong_phase', message: 'ルームが見つかりません' });
    }
    return this.enqueue(room, async () => {
      const result = reduce(room.state, event, this.ctx());
      if (result.error) return result.error;
      await this.commit(room, result.state, result.effects);
      return null;
    });
  }

  async tickAll(): Promise<void> {
    await Promise.all([...this.rooms.keys()].map((id) => this.tickRoom(id)));
  }

  private async tickRoom(id: string): Promise<void> {
    const state = this.rooms.get(id)?.state;
    if (state && this.opts.npc) {
      this.opts.npc.step(id, state, (event) => this.dispatch(id, event));
    } else {
      await this.actForNpcs(id);
    }
    await this.dispatch(id, { type: 'Tick' });
  }

  /**
   * カード公開・投票でNPC席が待たれないよう、少し待ってからランダムに行動させる。
   * AIによる行動（S3）が入るまでの代替で、AI失敗時のフォールバックにもなる。
   */
  private async actForNpcs(id: string): Promise<void> {
    const state = this.rooms.get(id)?.state;
    if (!state || state.deadlineAt === null) return;
    const total =
      state.phase === 'REVEAL' ? CONFIG.REVEAL_SEC : state.phase === 'VOTE' ? CONFIG.VOTE_SEC : 0;
    if (total === 0) return;
    const elapsedMs = this.now() - (state.deadlineAt - total * 1000);
    if (elapsedMs < CONFIG.NPC_FALLBACK_DELAY_SEC * 1000) return;

    for (const seat of state.seats) {
      if (seat.kind !== 'npc') continue;
      if (state.phase === 'REVEAL' && state.picks[seat.index] === undefined) {
        const open = characterOf(state, seat).cards.filter(
          (c) => !state.revealed.some((r) => r.cardId === c.id),
        );
        const card = open[Math.floor(this.rng() * open.length)];
        if (card) {
          await this.dispatch(id, { type: 'PickCard', seat: seat.index, cardId: card.id });
        }
      } else if (state.phase === 'VOTE' && state.votes[seat.index] === undefined) {
        const others = state.seats.filter((x) => x.index !== seat.index);
        const target = others[Math.floor(this.rng() * others.length)];
        if (target) {
          await this.dispatch(id, { type: 'Vote', seat: seat.index, target: target.index });
        }
      }
    }
  }

  /** サーバー再起動後に、Redis に残っている進行中のルームを復元する（設計書 §6.5）。 */
  async restoreAll(): Promise<number> {
    const { redis } = this.opts;
    let restored = 0;
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'room:*:state', 'COUNT', 100);
      cursor = next;
      for (const key of keys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const saved = JSON.parse(raw) as Pick<
          Room,
          'id' | 'scenarioId' | 'state' | 'seq' | 'participationIds' | 'recorded'
        >;
        if (this.rooms.has(saved.id) || saved.state.phase === 'CLOSED') continue;
        this.rooms.set(saved.id, {
          ...saved,
          listeners: new Set(),
          queue: Promise.resolve(),
        });
        restored++;
      }
    } while (cursor !== '0');
    return restored;
  }

  shutdown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private enqueue<T>(room: Room, task: () => Promise<T>): Promise<T> {
    const run = room.queue.then(task, task);
    room.queue = run.catch(() => undefined);
    return run;
  }

  private async commit(room: Room, state: RoomState, effects: Effect[]) {
    const { db } = this.opts;
    room.state = state;
    room.seq += 1;

    for (const effect of effects) {
      if (effect.type === 'MarkPlayed') {
        await this.guard('プレイ済みの記録', () => markPlayed(db, room.scenarioId, effect.userIds));
      }
    }

    // 結果が出た、または中断した時点で一度だけDBに書く。失敗したら次の更新で再試行する
    if (!room.recorded && (state.result !== null || state.aborted)) {
      const ok = await this.guard('結果の保存', () =>
        finishGame(db, room.id, room.participationIds, state, new Date(this.now())),
      );
      room.recorded = ok;
    }

    await this.saveSnapshot(room);
    for (const listener of room.listeners) listener({ state, seq: room.seq, effects });

    if (state.phase === 'CLOSED') {
      this.rooms.delete(room.id);
      await this.guard('スナップショットの期限設定', async () => {
        await this.opts.redis.expire(snapshotKey(room.id), 60 * 60);
      });
    }
  }

  private async saveSnapshot(room: Room) {
    const { id, scenarioId, state, seq, participationIds, recorded } = room;
    await this.guard('スナップショットの保存', async () => {
      await this.opts.redis.set(
        snapshotKey(id),
        JSON.stringify({ id, scenarioId, state, seq, participationIds, recorded }),
        'EX',
        SNAPSHOT_TTL_SEC,
      );
    });
  }

  /** 保存の失敗でゲームを止めない。失敗はログに残す。 */
  private async guard(label: string, task: () => Promise<unknown>): Promise<boolean> {
    try {
      await task();
      return true;
    } catch (e) {
      console.error(`[room-manager] ${label}に失敗しました`, e);
      return false;
    }
  }
}
