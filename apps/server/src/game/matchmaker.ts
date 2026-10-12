import { SEAT_COUNT } from '@mm/shared';
import type { Participant } from '@mm/game-core';
import type { Db } from '../db';
import type { RoomManager } from './room-manager';

export type EnqueueError =
  'scenario_unavailable' | 'already_played' | 'invalid_size' | 'already_queued' | 'in_game';

export type MatchStatus =
  | { status: 'waiting'; scenarioId: string; size: number; waiting: number }
  | { status: 'matched'; roomId: string }
  | { status: 'none' };

interface QueueEntry {
  userId: string;
  scenarioId: string;
  size: number;
}

/**
 * 同じシナリオ・同じ人数指定の人を集めて、ルームを作る。設計書 §10.1。
 * MVP は単一サーバーなので、待機列はメモリに持つ。
 * 待機のタイムアウトによるNPC補完と「今すぐ開始」は S4 で追加する。
 */
export class Matchmaker {
  private queues = new Map<string, QueueEntry[]>();

  constructor(
    private readonly db: Db,
    private readonly rooms: RoomManager,
  ) {}

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
    queue.push({ userId, scenarioId, size });
    this.queues.set(key, queue);

    if (queue.length >= size) {
      const members = queue.splice(0, size);
      if (queue.length === 0) this.queues.delete(key);
      try {
        await this.startRoom(scenarioId, members);
      } catch (e) {
        // ルームを作れなかったら、待機列に戻す
        this.queues.set(key, [...members, ...(this.queues.get(key) ?? [])]);
        throw e;
      }
    }
    return null;
  }

  private async startRoom(scenarioId: string, members: QueueEntry[]) {
    const participants: Participant[] = [
      ...members.map((m) => ({ kind: 'human' as const, userId: m.userId })),
      ...Array.from({ length: SEAT_COUNT - members.length }, () => ({ kind: 'npc' as const })),
    ];
    await this.rooms.createRoom(scenarioId, participants);
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
    if (entry) {
      const waiting = this.queues.get(this.key(entry.scenarioId, entry.size))?.length ?? 0;
      return { status: 'waiting', scenarioId: entry.scenarioId, size: entry.size, waiting };
    }
    return { status: 'none' };
  }
}
