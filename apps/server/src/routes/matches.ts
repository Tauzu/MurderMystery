import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EnqueueError } from '../game/matchmaker';

const body = z.object({ scenarioId: z.string().uuid(), size: z.number().int() });

const errorResponse: Record<EnqueueError, { status: number; message: string }> = {
  invalid_size: { status: 400, message: '人数は1〜4で指定してください' },
  scenario_unavailable: { status: 404, message: 'このシナリオは遊べません' },
  already_played: { status: 409, message: 'このシナリオはプレイ済みです' },
  already_queued: { status: 409, message: 'すでにマッチング待機中です' },
  in_game: { status: 409, message: 'ゲームの進行中です' },
};

export async function matchRoutes(app: FastifyInstance) {
  const { matchmaker } = app.deps;

  // マッチングに参加する。人数が揃うと、ルームが作られる
  app.post('/matches', async (request, reply) => {
    const userId = await app.requireUserId(request, reply);
    if (!userId) return;
    const parsed = body.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ code: 'invalid_request', message: '入力内容が正しくありません' });
    }
    const error = await matchmaker.enqueue(userId, parsed.data.scenarioId, parsed.data.size);
    if (error) {
      const { status, message } = errorResponse[error];
      return reply.code(status).send({ code: error, message });
    }
    return reply.code(202).send(matchmaker.status(userId));
  });

  // 待機中か、ルームに入れるかを返す。画面は数秒おきに呼ぶ
  app.get('/matches/current', async (request, reply) => {
    const userId = await app.requireUserId(request, reply);
    if (!userId) return;
    return matchmaker.status(userId);
  });

  // 「今すぐNPCで開始」。待機中の人だけで、不足分をNPCで補って始める
  app.post('/matches/current/start', async (request, reply) => {
    const userId = await app.requireUserId(request, reply);
    if (!userId) return;
    const started = await matchmaker.startNow(userId);
    if (!started) {
      return reply.code(409).send({ code: 'not_waiting', message: '待機中ではありません' });
    }
    return reply.code(202).send(matchmaker.status(userId));
  });

  app.delete('/matches/current', async (request, reply) => {
    const userId = await app.requireUserId(request, reply);
    if (!userId) return;
    matchmaker.cancel(userId);
    return reply.code(204).send();
  });
}
