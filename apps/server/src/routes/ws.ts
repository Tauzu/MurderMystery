import {
  clientMessageSchema,
  projectView,
  type ClientMessage,
  type RoomEvent,
  type ServerMessage,
} from '@mm/game-core';
import { CONFIG } from '@mm/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RoomUpdate } from '../game/room-manager';
import { env } from '../env';
import { SESSION_COOKIE, getSessionUserId } from '../session';

const query = z.object({ roomId: z.string().uuid() });

// 閉じるときのコード（4000番台はアプリ用）
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_FORBIDDEN = 4403;
const CLOSE_NOT_FOUND = 4404;

/** WebSocketでゲームに参加する。設計書 §7。 */
export async function wsRoutes(app: FastifyInstance) {
  const { rooms, redis } = app.deps;

  app.get('/ws', { websocket: true }, async (socket, request) => {
    const send = (msg: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    // メッセージを取りこぼさないよう、認証の前に受信の準備をしておく
    const pending: string[] = [];
    let onMessage: ((raw: string) => void) | null = null;
    socket.on('message', (data: Buffer) => {
      const raw = data.toString();
      if (onMessage) onMessage(raw);
      else pending.push(raw);
    });

    // 他のサイトからの接続を拒否する。ブラウザは Origin を付ける（テストなどの非ブラウザは付けない）
    const origin = request.headers.origin;
    if (origin && !env.webOrigins.includes(origin))
      return socket.close(CLOSE_FORBIDDEN, 'forbidden origin');

    const q = query.safeParse(request.query);
    const sid = request.cookies[SESSION_COOKIE];
    const userId = sid ? await getSessionUserId(redis, sid) : null;
    if (!userId) return socket.close(CLOSE_UNAUTHORIZED, 'unauthorized');
    if (!q.success) return socket.close(CLOSE_NOT_FOUND, 'not found');

    const roomId = q.data.roomId;
    const current = rooms.getState(roomId);
    if (!current) return socket.close(CLOSE_NOT_FOUND, 'not found');
    const seatIndex = current.state.seats.findIndex((s) => s.userId === userId);
    if (seatIndex < 0) return socket.close(CLOSE_FORBIDDEN, 'forbidden');

    const sendSnapshot = (update: { state: RoomUpdate['state']; seq: number }) => {
      const seat = update.state.seats[seatIndex]!;
      send({
        type: 'snapshot',
        seq: update.seq,
        view: projectView(update.state, seatIndex, Date.now()),
        // NPCに切り替わった元のプレイヤーは、観戦のみ
        spectator: seat.kind !== 'human',
      });
    };

    const unsubscribe = rooms.subscribe(roomId, (update) => {
      for (const effect of update.effects) {
        if (effect.type === 'Warn' && effect.seat === seatIndex) {
          send({ type: 'warn', switchInSec: effect.switchInSec });
        }
        if (effect.type === 'SwitchedToNpc' && effect.seat === seatIndex) {
          send({ type: 'switched' });
        }
      }
      sendSnapshot(update);
    });
    if (!unsubscribe) return socket.close(CLOSE_NOT_FOUND, 'not found');
    socket.on('close', unsubscribe);

    let lastChatAt = 0;

    const toEvent = (msg: ClientMessage): RoomEvent | null => {
      switch (msg.type) {
        case 'ready':
          return { type: 'Ready', seat: seatIndex };
        case 'pickTarget':
          return { type: 'PickTarget', seat: seatIndex, target: msg.target };
        case 'chat':
          return { type: 'Chat', seat: seatIndex, body: msg.body };
        case 'agreeEndTalk':
          return { type: 'AgreeEndTalk', seat: seatIndex };
        case 'vote':
          return { type: 'Vote', seat: seatIndex, target: msg.targetSeat };
        default:
          return null;
      }
    };

    const handle = async (raw: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return send({ type: 'error', code: 'invalid_message', message: '形式が正しくありません' });
      }
      const msg = clientMessageSchema.safeParse(parsed);
      if (!msg.success) {
        return send({ type: 'error', code: 'invalid_message', message: '形式が正しくありません' });
      }

      if (msg.data.type === 'ping') return send({ type: 'pong' });

      const latest = rooms.getState(roomId);
      if (!latest) return socket.close(CLOSE_NOT_FOUND, 'not found');
      if (msg.data.type === 'resync') return sendSnapshot(latest);

      // 観戦者（NPCに切り替わった元のプレイヤー）は操作できない
      if (latest.state.seats[seatIndex]?.kind !== 'human') {
        return send({ type: 'error', code: 'spectator', message: '観戦中は操作できません' });
      }

      if (msg.data.type === 'chat') {
        const now = Date.now();
        if (now - lastChatAt < 1000 / CONFIG.CHAT_RATE_PER_SEC) {
          return send({ type: 'error', code: 'rate_limited', message: '発言の間隔が短すぎます' });
        }
        lastChatAt = now;
      }

      const event = toEvent(msg.data);
      if (!event) return;
      const error = await rooms.dispatch(roomId, event);
      if (error) send({ type: 'error', code: error.code, message: error.message });
    };

    onMessage = (raw) => void handle(raw);
    for (const raw of pending.splice(0)) onMessage(raw);

    sendSnapshot(current);
  });
}
