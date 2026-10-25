import { checkScenarioStructure, CONFIG } from '@mm/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client';

const params = z.object({ id: z.string().uuid() });
const body = z.object({ draft: z.record(z.string(), z.unknown()).optional() });

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ code: 'not_found', message: '見つかりません' });

const titleOf = (draft: Record<string, unknown>) => {
  const t = typeof draft.title === 'string' ? draft.title.trim() : '';
  return t === '' ? '（無題）' : t.slice(0, 40);
};

/** 投稿者本人のシナリオ（下書き・公開済み）。設計書 §10。 */
export async function myScenarioRoutes(app: FastifyInstance) {
  const { db } = app.deps;

  const parseDraft = (reply: FastifyReply, raw: unknown) => {
    const parsed = body.safeParse(raw ?? {});
    if (!parsed.success) {
      void reply
        .code(400)
        .send({ code: 'invalid_request', message: '下書きの形式が正しくありません' });
      return null;
    }
    const draft = parsed.data.draft ?? {};
    if (JSON.stringify(draft).length > CONFIG.DRAFT_MAX_CHARS) {
      void reply.code(413).send({ code: 'too_large', message: '下書きが大きすぎます' });
      return null;
    }
    return draft;
  };

  app.get('/me/scenarios', async (request, reply) => {
    const userId = await app.requireUserId(request, reply);
    if (!userId) return;
    const scenarios = await db.scenario.findMany({
      where: { authorId: userId },
      select: { id: true, title: true, summary: true, status: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });
    return { scenarios };
  });

  // 編集用。投稿者本人にだけ全項目を返す
  app.get('/me/scenarios/:id', async (request, reply) => {
    const userId = await app.requireUserId(request, reply);
    if (!userId) return;
    const p = params.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const s = await db.scenario.findFirst({
      where: { id: p.data.id, authorId: userId },
      select: { id: true, status: true, draft: true, updatedAt: true },
    });
    if (!s) return notFound(reply);
    return { scenario: { ...s, issues: s.draft ? checkScenarioStructure(s.draft) : [] } };
  });

  app.post('/scenarios', async (request, reply) => {
    const userId = await app.requireUserId(request, reply);
    if (!userId) return;
    const draft = parseDraft(reply, request.body);
    if (!draft) return;
    const count = await db.scenario.count({ where: { authorId: userId, status: 'draft' } });
    if (count >= CONFIG.DRAFT_MAX_COUNT) {
      return reply
        .code(409)
        .send({ code: 'too_many_drafts', message: `下書きは${CONFIG.DRAFT_MAX_COUNT}件までです` });
    }
    const s = await db.scenario.create({
      data: {
        authorId: userId,
        title: titleOf(draft),
        summary: '',
        introText: '',
        endingText: '',
        status: 'draft',
        draft: draft as Prisma.InputJsonObject,
      },
      select: { id: true, status: true, updatedAt: true },
    });
    return reply.code(201).send({ scenario: { ...s, issues: checkScenarioStructure(draft) } });
  });

  app.put('/scenarios/:id', async (request, reply) => {
    const userId = await app.requireUserId(request, reply);
    if (!userId) return;
    const p = params.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const draft = parseDraft(reply, request.body);
    if (!draft) return;
    // 公開後の本文は変更できない（仕様書 §6.2）。status を条件に含めて競合も防ぐ
    const r = await db.scenario.updateMany({
      where: { id: p.data.id, authorId: userId, status: 'draft' },
      data: { title: titleOf(draft), draft: draft as Prisma.InputJsonObject },
    });
    if (r.count === 0) {
      const exists = await db.scenario.findFirst({ where: { id: p.data.id, authorId: userId } });
      if (!exists) return notFound(reply);
      return reply
        .code(409)
        .send({ code: 'not_editable', message: '公開したシナリオは編集できません' });
    }
    const s = await db.scenario.findUniqueOrThrow({
      where: { id: p.data.id },
      select: { id: true, status: true, updatedAt: true },
    });
    return { scenario: { ...s, issues: checkScenarioStructure(draft) } };
  });

  app.delete('/scenarios/:id', async (request, reply) => {
    const userId = await app.requireUserId(request, reply);
    if (!userId) return;
    const p = params.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const r = await db.scenario.deleteMany({
      where: { id: p.data.id, authorId: userId, status: 'draft' },
    });
    if (r.count === 0) return notFound(reply);
    return reply.code(204).send();
  });
}
