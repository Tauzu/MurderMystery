import { readFileSync } from 'node:fs';
import type { LlmClient } from '@mm/npc';
import { CONFIG } from '@mm/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { createDb } from './db';
import { env } from './env';
import { cleanupTestUsers, sessionCookie, uniqueEmail } from './test-helpers';

const db = createDb(env.databaseUrl);
const redis = new Redis(env.redisUrl);

/** 返答を差し替えられるAI。不適切表現用と整合性用を、プロンプトで見分ける */
let moderationReply = '{"flags":[]}';
let consistencyReply = '{"findings":[]}';
let llmCalls = 0;
const llm: LlmClient = {
  async complete(req) {
    llmCalls += 1;
    const text = req.user.includes('不適切表現を検査') ? moderationReply : consistencyReply;
    return { text, inputTokens: 100, outputTokens: 20 };
  },
};
const app = buildApp({ db, redis, llm });
const noLlmApp = buildApp({ db, redis });

const { slug: _slug, ...valid } = JSON.parse(
  readFileSync(new URL('../../../scenarios/001-yukiyama-sansou.json', import.meta.url), 'utf-8'),
);

const users: string[] = [];

beforeEach(() => {
  moderationReply = '{"flags":[]}';
  consistencyReply = '{"findings":[]}';
  llmCalls = 0;
});

afterAll(async () => {
  await db.scenario.deleteMany({ where: { authorId: { in: users } } });
  for (const id of users) {
    const keys = await redis.keys(`mm:scheck:${id}:*`);
    if (keys.length > 0) await redis.del(...keys);
  }
  await cleanupTestUsers(db);
  await app.close();
  await noLlmApp.close();
  await db.$disconnect();
  redis.disconnect();
});

async function login() {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: uniqueEmail(),
      password: 'correct-horse-battery',
      displayName: '投稿者',
      agreeAge: true,
    },
  });
  users.push(res.json().user.id);
  return sessionCookie(res);
}

async function newDraft(cookies: Record<string, string>, draft: object = valid) {
  const res = await app.inject({ method: 'POST', url: '/scenarios', cookies, payload: { draft } });
  return res.json().scenario.id as string;
}

/** チェックを始めて、終わるまで待つ */
async function runCheck(cookies: Record<string, string>, id: string) {
  const start = await app.inject({ method: 'POST', url: `/scenarios/${id}/check`, cookies });
  expect([200, 202]).toContain(start.statusCode);
  for (let i = 0; i < 50; i++) {
    const res = await app.inject({ method: 'GET', url: `/scenarios/${id}/check`, cookies });
    const body = res.json();
    if (body.check?.status !== 'running') return body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('チェックが終わりません');
}

const publish = (cookies: Record<string, string>, id: string, payload: object = {}) =>
  app.inject({ method: 'POST', url: `/scenarios/${id}/publish`, cookies, payload });

describe('AIチェックと公開', () => {
  it('チェックを通した下書きを公開でき、他の人は遊べるが投稿者は遊べない', async () => {
    const cookies = await login();
    const other = await login();
    const id = await newDraft(cookies);

    // チェック前は公開できない
    expect((await publish(cookies, id)).json().code).toBe('check_required');

    const done = await runCheck(cookies, id);
    expect(done.check.status).toBe('done');
    expect(done.check.moderation.ok).toBe(true);
    expect(done.stale).toBe(false);

    const res = await publish(cookies, id);
    expect(res.statusCode).toBe(200);

    const s = await db.scenario.findUniqueOrThrow({
      where: { id },
      include: { characters: { include: { cards: true } } },
    });
    expect(s.status).toBe('published');
    expect(s.draft).toBeNull();
    expect(s.characters).toHaveLength(4);
    expect(s.characters.flatMap((c) => c.cards)).toHaveLength(16);
    expect(s.characters.filter((c) => c.isCulprit)).toHaveLength(1);
    expect(s.characters.flatMap((c) => c.cards).filter((c) => c.isFabricated)).toHaveLength(1);

    const list = async (c: Record<string, string>) =>
      (await app.inject({ method: 'GET', url: '/scenarios/available', cookies: c })).json()
        .scenarios as { id: string }[];
    expect((await list(other)).some((x) => x.id === id)).toBe(true);
    expect((await list(cookies)).some((x) => x.id === id)).toBe(false);

    // 公開後は編集も再公開もできない
    const put = await app.inject({
      method: 'PUT',
      url: `/scenarios/${id}`,
      cookies,
      payload: { draft: valid },
    });
    expect(put.statusCode).toBe(409);
    expect((await publish(cookies, id)).statusCode).toBe(404);
  });

  it('不適切表現が見つかると公開できない', async () => {
    moderationReply = '{"flags":[{"category":"violence","where":"……","reason":"過度"}]}';
    const cookies = await login();
    const id = await newDraft(cookies);
    const done = await runCheck(cookies, id);
    expect(done.check.moderation.ok).toBe(false);
    expect((await publish(cookies, id, { acknowledgeWarnings: true })).json().code).toBe(
      'moderation_failed',
    );
  });

  it('整合性の指摘がある場合は、確認した上でなら公開できる', async () => {
    consistencyReply = '{"findings":[{"aspect":"culprit","message":"手がかりが弱い"}]}';
    const cookies = await login();
    const id = await newDraft(cookies);
    const done = await runCheck(cookies, id);
    expect(done.check.consistency.verdict).toBe('warn');
    expect((await publish(cookies, id)).json().code).toBe('warnings_unacknowledged');
    expect((await publish(cookies, id, { acknowledgeWarnings: true })).statusCode).toBe(200);
  });

  it('チェック後に下書きを直すと、再チェックが必要になる', async () => {
    const cookies = await login();
    const id = await newDraft(cookies);
    await runCheck(cookies, id);
    await app.inject({
      method: 'PUT',
      url: `/scenarios/${id}`,
      cookies,
      payload: { draft: { ...valid, summary: '直した概要' } },
    });
    const state = await app.inject({ method: 'GET', url: `/scenarios/${id}/check`, cookies });
    expect(state.json().stale).toBe(true);
    expect((await publish(cookies, id)).json().code).toBe('check_required');
  });

  it('同じ内容の再チェックはAIを呼ばず、回数にも数えない', async () => {
    const cookies = await login();
    const id = await newDraft(cookies);
    await runCheck(cookies, id);
    const calls = llmCalls;
    for (let i = 0; i < CONFIG.SCENARIO_CHECK_PER_DAY + 2; i++) {
      const again = await app.inject({ method: 'POST', url: `/scenarios/${id}/check`, cookies });
      expect(again.statusCode).toBe(200);
    }
    expect(llmCalls).toBe(calls);
  });

  it('1日の回数を超えると、チェックを断る', async () => {
    const cookies = await login();
    const id = await newDraft(cookies);
    for (let i = 0; i < CONFIG.SCENARIO_CHECK_PER_DAY; i++) {
      await app.inject({
        method: 'PUT',
        url: `/scenarios/${id}`,
        cookies,
        payload: { draft: { ...valid, summary: `概要${i}` } },
      });
      await runCheck(cookies, id);
    }
    await app.inject({
      method: 'PUT',
      url: `/scenarios/${id}`,
      cookies,
      payload: { draft: { ...valid, summary: '概要の最後' } },
    });
    const over = await app.inject({ method: 'POST', url: `/scenarios/${id}/check`, cookies });
    expect(over.statusCode).toBe(429);
    expect(over.json().code).toBe('check_limit');
  });

  it('入力に不足があるとチェックも公開もできず、指摘を返す', async () => {
    const cookies = await login();
    const id = await newDraft(cookies, { title: '未完成' });
    const check = await app.inject({ method: 'POST', url: `/scenarios/${id}/check`, cookies });
    expect(check.statusCode).toBe(422);
    expect(check.json().issues.length).toBeGreaterThan(0);
    expect((await publish(cookies, id)).statusCode).toBe(422);
  });

  it('AIの返答が読めないときは error になり、公開できない', async () => {
    moderationReply = '申し訳ありません';
    const cookies = await login();
    const id = await newDraft(cookies);
    const done = await runCheck(cookies, id);
    expect(done.check.status).toBe('error');
    expect((await publish(cookies, id)).json().code).toBe('check_required');
  });

  it('他人のシナリオは、チェックも公開もできない', async () => {
    const cookies = await login();
    const other = await login();
    const id = await newDraft(cookies);
    expect(
      (await app.inject({ method: 'POST', url: `/scenarios/${id}/check`, cookies: other }))
        .statusCode,
    ).toBe(404);
    expect((await publish(other, id)).statusCode).toBe(404);
  });

  it('AIが設定されていなければ、チェックは使えない', async () => {
    const res = await noLlmApp.inject({
      method: 'POST',
      url: '/auth/register',
      payload: {
        email: uniqueEmail(),
        password: 'correct-horse-battery',
        displayName: '投稿者',
        agreeAge: true,
      },
    });
    users.push(res.json().user.id);
    const cookies = sessionCookie(res);
    const created = await noLlmApp.inject({
      method: 'POST',
      url: '/scenarios',
      cookies,
      payload: { draft: valid },
    });
    const id = created.json().scenario.id;
    const check = await noLlmApp.inject({ method: 'POST', url: `/scenarios/${id}/check`, cookies });
    expect(check.statusCode).toBe(503);
  });
});

describe('非公開', () => {
  it('投稿者が非公開にすると一覧から消え、戻すと再び出る', async () => {
    const cookies = await login();
    const other = await login();
    const id = await newDraft(cookies);
    await runCheck(cookies, id);
    await publish(cookies, id);

    const visible = async () =>
      (
        (await app.inject({ method: 'GET', url: '/scenarios/available', cookies: other })).json()
          .scenarios as { id: string }[]
      ).some((s) => s.id === id);
    expect(await visible()).toBe(true);

    expect(
      (await app.inject({ method: 'POST', url: `/scenarios/${id}/hide`, cookies })).statusCode,
    ).toBe(200);
    expect(await visible()).toBe(false);
    // 他の人は操作できない
    expect(
      (await app.inject({ method: 'POST', url: `/scenarios/${id}/unhide`, cookies: other }))
        .statusCode,
    ).toBe(404);

    expect(
      (await app.inject({ method: 'POST', url: `/scenarios/${id}/unhide`, cookies })).statusCode,
    ).toBe(200);
    expect(await visible()).toBe(true);
  });
});
