import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

const params = z.object({ id: z.string().uuid() });

/** 一覧・詳細で返す項目。状況文・手札・結末文などの真相は含めない（設計書 §10）。 */
const publicSelect = { id: true, title: true, summary: true, publishedAt: true } as const;

export async function scenarioRoutes(app: FastifyInstance) {
  const { db } = app.deps;

  // 未プレイの公開シナリオ。自分が投稿したものは除く（仕様書 §7.3）
  app.get('/scenarios/available', async (request, reply) => {
    const userId = await app.requireUserId(request, reply);
    if (!userId) return;
    const scenarios = await db.scenario.findMany({
      where: {
        status: 'published',
        OR: [{ authorId: null }, { authorId: { not: userId } }],
        played: { none: { userId } },
      },
      select: publicSelect,
      orderBy: { publishedAt: 'desc' },
    });
    return { scenarios };
  });

  app.get('/scenarios/:id', async (request, reply) => {
    const userId = await app.requireUserId(request, reply);
    if (!userId) return;
    const p = params.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ code: 'not_found', message: '見つかりません' });

    const scenario = await db.scenario.findFirst({
      where: { id: p.data.id, status: 'published' },
      select: publicSelect,
    });
    if (!scenario) return reply.code(404).send({ code: 'not_found', message: '見つかりません' });
    return { scenario };
  });
}
