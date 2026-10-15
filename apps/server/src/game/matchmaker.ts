import { CONFIG, SEAT_COUNT } from '@mm/shared';
import type { Participant } from '@mm/game-core';
import type { Db } from '../db';
import type { RoomManager } from './room-manager';

export type EnqueueError =
  'scenario_unavailable' | 'already_played' | 'invalid_size' | 'already_queued' | 'in_game';

export type MatchStatus =
  | {
      status: 'waiting';
      scenarioId: string;
      size: number;
      waiting: number;
      /** 待機の残り秒数。0になると不足分をNPCで補って開始する */
      remainingSec: number;
    }
  /** 開始の準備中（待機列から外れ、ルームを作っている途中） */
  | { status: 'starting' }
  | { status: 'matched'; roomId: string }
  | { status: 'none' };

interface QueueEntry {
  userId: string;
  scenarioId: string;
  size: number;
  enqueuedAt: number;
  /** 待機画面が最後に状況を確認した時刻（ブラウザを閉じた人を外すため） */
  lastSeenAt: number;
}

/**
 * 同じシナリオ・同じ人数指定の人を集めて、ルームを作る。設計書 §10.1。
 * MVP は単一サーバーなので、待機列はメモリに持つ。
 * 待機時間が上限（仕様書 §7.2）に達するか、本人が「今すぐ開始」を選ぶと、
 * 不足分をNPCで補って開始する。
 */
export class Matchmaker {
  private queues = new Map<string, QueueEntry[]>();
  /** 待機列から外れ、ルームを作っている最中のユーザー */
  private starting = new Set<string>();
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly rooms: RoomManager,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  private key(scenarioId: string, size: number) {
    return `${scenarioId}:${size}`;
  }

  private findEntry(userId: string): QueueEntry | null {
    for (const q of this.queues.values()) {
      const e = q.find((x) => x.userId === userId);
      if (e) return e;
    }
    return null;
  }

  async enqueue(userId: string, scenarioId: string, size: number): Promise<EnqueueError | null> {
    if (!Number.isInteger(size) || size < 1 || size > SEAT_COUNT) return 'invalid_size';
    if (this.rooms.findRoomByUser(userId)) return 'in_game';
    if (this.findEntry(userId)) return 'already_queued';

    const scenario = await this.db.scenario.findFirst({
      where: {
        id: scenarioId,
        status: 'published',
        OR: [{ authorId: null }, { authorId: { not: userId } }],
      },
      select: { id: true },
    });
    if (!scenario) return 'scenario_unavailable';
    const played = await this.db.playedScenario.findUnique({
      where: { userId_scenarioId: { userId, scenarioId } },
    });
    if (played) return 'already_played';

    // 上の検査の間に別の呼び出しで登録された場合に備えて、もう一度確認する
    if (this.findEntry(userId)) return 'already_queued';

    const key = this.key(scenarioId, size);
    const queue = this.queues.get(key) ?? [];
    queue.push({ userId, scenarioId, size, enqueuedAt: this.now(), lastSeenAt: this.now() });
    this.queues.set(key, queue);

    if (queue.length >= size) await this.launch(key, size);
    return null;
  }

  /** 待機列の先頭から最大 count 人を取り出して、不足分をNPCで補いルームを作る。 */
  private async launch(key: string, count: number) {
    const queue = this.queues.get(key);
    if (!queue || queue.length === 0) return;
    const members = queue.splice(0, count);
    if (queue.length === 0) this.queues.delete(key);
    members.forEach((m) => this.starting.add(m.userId));
    try {
      await this.startRoom(members[0]!.scenarioId, members);
    } catch (e) {
      // ルームを作れなかったら、待機列に戻す
      this.queues.set(key, [...members, ...(this.queues.get(key) ?? [])]);
      throw e;
    } finally {
      members.forEach((m) => this.starting.delete(m.userId));
    }
  }

  /** 「今すぐNPCで開始」。同じ待機列で待っている人をまとめて、不足分をNPCで補って始める。 */
  async startNow(userId: string): Promise<boolean> {
    for (const [key, q] of this.queues) {
      if (q.some((x) => x.userId === userId)) {
        await this.launch(key, q[0]!.size);
        return true;
      }
    }
    return false;
  }

  /** 1秒ごとに呼ぶ。待機が上限に達した待機列を、不足分をNPCで補って開始する。 */
  async tick(): Promise<void> {
    this.dropStale();
    const limitMs = CONFIG.MATCH_WAIT_SEC * 1000;
    for (const [key, q] of [...this.queues]) {
      if (q.length > 0 && this.now() - q[0]!.enqueuedAt >= limitMs) {
        await this.launch(key, q[0]!.size).catch(() => undefined);
      }
    }
  }

  private async startRoom(scenarioId: string, members: QueueEntry[]) {
    const participants: Participant[] = [
      ...members.map((m) => ({ kind: 'human' as const, userId: m.userId })),
      ...Array.from({ length: SEAT_COUNT - members.length }, () => ({ kind: 'npc' as const })),
    ];
    await this.rooms.createRoom(scenarioId, participants);
  }

  /** 待機画面からの確認が途絶えた人（ブラウザを閉じた人など）を待機列から外す。 */
  private dropStale() {
    const staleMs = CONFIG.MATCH_STALE_SEC * 1000;
    for (const [key, q] of [...this.queues]) {
      const alive = q.filter((e) => this.now() - e.lastSeenAt <= staleMs);
      if (alive.length === q.length) continue;
      if (alive.length === 0) this.queues.delete(key);
      else this.queues.set(key, alive);
    }
  }

  cancel(userId: string): boolean {
    for (const [key, q] of this.queues) {
      const i = q.findIndex((x) => x.userId === userId);
      if (i >= 0) {
        q.splice(i, 1);
        if (q.length === 0) this.queues.delete(key);
        return true;
      }
    }
    return false;
  }

  status(userId: string): MatchStatus {
    const roomId = this.rooms.findRoomByUser(userId);
    if (roomId) return { status: 'matched', roomId };
    const entry = this.findEntry(userId);
    if (this.starting.has(userId)) return { status: 'starting' };
    if (entry) {
      entry.lastSeenAt = this.now();
      const queue = this.queues.get(this.key(entry.scenarioId, entry.size)) ?? [];
      const elapsedMs = this.now() - (queue[0]?.enqueuedAt ?? entry.enqueuedAt);
      return {
        status: 'waiting',
        scenarioId: entry.scenarioId,
        size: entry.size,
        waiting: queue.length,
        remainingSec: Math.max(0, Math.ceil((CONFIG.MATCH_WAIT_SEC * 1000 - elapsedMs) / 1000)),
      };
    }
    return { status: 'none' };
  }
}
