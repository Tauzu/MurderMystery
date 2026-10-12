import { z } from 'zod';
import type { RoomView } from './view';

/**
 * クライアント → サーバーのメッセージ。設計書 §7.2。
 * 席はサーバーが接続から決めるため、メッセージには含めない。
 */
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('pickCard'), cardId: z.string().min(1).max(64) }),
  z.object({ type: z.literal('chat'), body: z.string().max(1000) }),
  z.object({ type: z.literal('agreeEndTalk') }),
  z.object({ type: z.literal('vote'), targetSeat: z.number().int() }),
  z.object({ type: z.literal('resync') }),
  z.object({ type: z.literal('ping') }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

/**
 * サーバー → クライアントのメッセージ。
 * 状態が変わるたびに、その接続のプレイヤーが見てよい内容の全体（snapshot）を送る。
 * 差分配信は、必要になった時点で検討する。
 */
export type ServerMessage =
  | {
      type: 'snapshot';
      /** ルーム内の連番。クライアントは古いものを無視できる */
      seq: number;
      view: RoomView;
      /** NPCに切り替わった元のプレイヤーなど、操作できない観戦者か */
      spectator: boolean;
    }
  /** 無操作のため、switchInSec 秒後にNPCへ切り替わる */
  | { type: 'warn'; switchInSec: number }
  /** 自分の席がNPCに切り替わった */
  | { type: 'switched' }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };
