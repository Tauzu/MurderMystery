import { createHash } from 'node:crypto';
import { runScenarioCheck } from '@mm/npc';
import {
  checkScenarioStructure,
  CONFIG,
  scenarioContentSchema,
  type ScenarioCheckResult,
  type ScenarioContent,
} from '@mm/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client';

const params = z.object({ id: z.string().uuid() });
const publishBody = z.object({ acknowledgeWarnings: z.boolean().optional() });

const notFound = (reply: FastifyReply) =>
  reply.code(404).send({ code: 'not_found', message: '見つかりません' });

const asJson = (v: ScenarioCheckResult) => v as unknown as Prisma.InputJsonObject;
const resultOf = (raw: unknown) => (raw ?? null) as ScenarioCheckResult | null;

/** 下書きを検証して、内容のハッシュを返す。構造に問題があれば指摘を返す */
function contentOf(draft: unknown) {
  const parsed = scenarioContentSchema.safeParse(draft);
  if (!parsed.success) return { issues: checkScenarioStructure(draft) };
  const hash = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
  return { content: parsed.data, hash };
}

/** AIチェック、公開、非公開（設計書 §9・§10）。 */
export async function publishRoutes(app: FastifyInstance) {
  const { db } = app.deps;

  const loadDraft = (userId: string, id: string) =>
    db.scenario.findFirst({
      where: { id, authorId: userId, status: 'draft' },
      select: { id: true, draft: true, checkResult: true },
    });

  const invalidStructure = (reply: FastifyReply, issues: unknown) =>
    reply.code(422).send({ code: 'invalid_structure', message: '入力に不足があります', issues });

  // AIチェックの開始。同じ内容は再実行せず、結果を返す（費用の節約）
  app.post('/scenarios/:id/check', async (request, reply) => {
    const userId = await app.requireUserId(request, reply);
    if (!userId) return;
    const p = params.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const s = await loadDraft(userId, p.data.id);
    if (!s) return notFound(reply);
    const { llm, redis, now } = app.deps;
    if (!llm) {
      return reply
        .code(503)
        .send({ code: 'check_unavailable', message: 'AIチェックは現在使えません' });
    }

    const checked = contentOf(s.draft);
    if (!checked.content) return invalidStructure(reply, checked.issues);
    const { content, hash } = checked;

    const prev = resultOf(s.checkResult);
    if (prev && prev.hash === hash) {
      const fresh = now() - prev.startedAt < CONFIG.SCENARIO_CHECK_TIMEOUT_SEC * 2000;
      if (prev.status === 'done' || (prev.status === 'running' && fresh)) {
        return reply.code(prev.status === 'done' ? 200 : 202).send({ check: prev });
      }
    }

    // 1人あたりの1日の回数制限（同じ内容の結果の再取得は数えない）
    const key = `mm:scheck:${userId}:${new Date(now()).toISOString().slice(0, 10)}`;
    const used = await redis.incr(key);
    if (used === 1) await redis.expire(key, 2 * 24 * 60 * 60);
    if (used > CONFIG.SCENARIO_CHECK_PER_DAY) {
      return reply.code(429).send({
        code: 'check_limit',
        message: `AIチェックは1日${CONFIG.SCENARIO_CHECK_PER_DAY}回までです。明日またお試しください`,
      });
    }

    const running: ScenarioCheckResult = { status: 'running', hash, startedAt: now() };
    await db.scenario.update({ where: { id: s.id }, data: { checkResult: asJson(running) } });
    void (async () => {
      let result: ScenarioCheckResult;
      try {
        const r = await runScenarioCheck({ llm }, content);
        result = { ...running, status: 'done', ...r };
      } catch (e) {
        result = {
          ...running,
          status: 'error',
          error: e instanceof Error ? e.message : 'AIチェックに失敗しました',
        };
      }
      // 実行中に下書きが書き換わっていたら、古い結果で上書きしない
      await db.scenario.updateMany({
        where: { id: s.id, status: 'draft', checkResult: { equals: asJson(running) } },
        data: { checkResult: asJson(result) },
      });
    })().catch(() => undefined);
    return reply.code(202).send({ check: running });
  });

  app.get('/scenarios/:id/check', async (request, reply) => {
    const userId = await app.requireUserId(request, reply);
    if (!userId) return;
    const p = params.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const s = await loadDraft(userId, p.data.id);
    if (!s) return notFound(reply);
    const check = resultOf(s.checkResult);
    // 下書きを直した後の結果は古い。画面で「再チェックが必要」と示すために知らせる
    return { check, stale: check !== null && check.hash !== contentOf(s.draft).hash };
  });

  app.post('/scenarios/:id/publish', async (request, reply) => {
    const userId = await app.requireUserId(request, reply);
    if (!userId) return;
    const p = params.safeParse(request.params);
    const b = publishBody.safeParse(request.body ?? {});
    if (!p.success || !b.success) return notFound(reply);
    const s = await loadDraft(userId, p.data.id);
    if (!s) return notFound(reply);

    const checked = contentOf(s.draft);
    if (!checked.content) return invalidStructure(reply, checked.issues);
    const check = resultOf(s.checkResult);
    if (!check || check.status !== 'done' || check.hash !== checked.hash) {
      return reply.code(409).send({
        code: 'check_required',
        message: '公開前に、今の内容でAIチェックを行ってください',
      });
    }
    if (!check.moderation?.ok) {
      return reply.code(409).send({
        code: 'moderation_failed',
        message: '不適切な表現が見つかったため公開できません',
      });
    }
    if (check.consistency?.verdict === 'warn' && !b.data.acknowledgeWarnings) {
      return reply.code(409).send({
        code: 'warnings_unacknowledged',
        message: '整合性チェックの指摘を確認した上で、公開を選んでください',
      });
    }

    const c: ScenarioContent = checked.content;
    // 公開は一度だけ。status=draft を条件にして、二重の公開を防ぐ
    const published = await db.$transaction(async (tx) => {
      const r = await tx.scenario.updateMany({
        where: { id: s.id, authorId: userId, status: 'draft' },
        data: {
          title: c.title,
          summary: c.summary,
          introText: c.introText,
          endingText: c.endingText,
          victimName: c.victimName ?? null,
          victimProfile: c.victimProfile ?? null,
          status: 'published',
          publishedAt: new Date(app.deps.now()),
          draft: Prisma.DbNull,
        },
      });
      if (r.count === 0) return false;
      for (const [slot, ch] of c.characters.entries()) {
        await tx.character.create({
          data: {
            scenarioId: s.id,
            slot,
            name: ch.name,
            publicProfile: ch.publicProfile,
            situationText: ch.situationText,
            isCulprit: ch.isCulprit,
            cards: {
              create: ch.cards.map((card, cardSlot) => ({
                slot: cardSlot,
                kind: card.kind,
                title: card.title,
                body: card.body,
                isFabricated: card.isFabricated ?? false,
              })),
            },
          },
        });
      }
      return true;
    });
    if (!published) return notFound(reply);
    return { scenario: { id: s.id, status: 'published' } };
  });

  // 投稿者による非公開／再公開。本文は変えられないので、再チェックなしで戻せる
  const setVisibility =
    (from: 'published' | 'hidden_by_author', to: 'published' | 'hidden_by_author') =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = await app.requireUserId(request, reply);
      if (!userId) return;
      const p = params.safeParse(request.params);
      if (!p.success) return notFound(reply);
      const r = await db.scenario.updateMany({
        where: { id: p.data.id, authorId: userId, status: from },
        data: { status: to },
      });
      if (r.count === 0) return notFound(reply);
      return { scenario: { id: p.data.id, status: to } };
    };
  app.post('/scenarios/:id/hide', setVisibility('published', 'hidden_by_author'));
  app.post('/scenarios/:id/unhide', setVisibility('hidden_by_author', 'published'));
}
