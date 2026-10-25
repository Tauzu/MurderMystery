import { CONFIG } from '@mm/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTestUsers, createTestApp, sessionCookie, uniqueEmail } from './test-helpers';

const t = createTestApp();
const authors: string[] = [];

async function login() {
  const res = await t.app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: uniqueEmail(),
      password: 'correct-horse-battery',
      displayName: '投稿者',
      agreeAge: true,
    },
  });
  const userId = res.json().user.id as string;
  authors.push(userId);
  return { cookies: sessionCookie(res), userId };
}

afterAll(async () => {
  // 投稿者を消すと author が null になって残るため、先に下書きを消す
  await t.db.scenario.deleteMany({ where: { authorId: { in: authors } } });
  await cleanupTestUsers(t.db);
  await t.close();
});

describe('下書きの保存と構造チェック', () => {
  it('未完成の下書きを保存でき、指摘つきで取得できる', async () => {
    const { cookies } = await login();
    const created = await t.app.inject({
      method: 'POST',
      url: '/scenarios',
      cookies,
      payload: { draft: { title: '雨の夜の事件' } },
    });
    expect(created.statusCode).toBe(201);
    const { scenario } = created.json();
    expect(scenario.status).toBe('draft');
    expect(scenario.issues.length).toBeGreaterThan(0);

    const got = await t.app.inject({ method: 'GET', url: `/me/scenarios/${scenario.id}`, cookies });
    expect(got.statusCode).toBe(200);
    expect(got.json().scenario.draft).toEqual({ title: '雨の夜の事件' });

    const updated = await t.app.inject({
      method: 'PUT',
      url: `/scenarios/${scenario.id}`,
      cookies,
      payload: { draft: { title: '雨の夜の事件 改', summary: '概要' } },
    });
    expect(updated.statusCode).toBe(200);
    const list = await t.app.inject({ method: 'GET', url: '/me/scenarios', cookies });
    expect(list.json().scenarios).toEqual([
      expect.objectContaining({ id: scenario.id, title: '雨の夜の事件 改', status: 'draft' }),
    ]);
  });

  it('下書きは投稿者本人だけが見られ、他の人は編集も削除もできない', async () => {
    const a = await login();
    const b = await login();
    const created = await t.app.inject({
      method: 'POST',
      url: '/scenarios',
      cookies: a.cookies,
      payload: { draft: { title: '秘密' } },
    });
    const id = created.json().scenario.id as string;
    for (const req of [
      { method: 'GET', url: `/me/scenarios/${id}` },
      { method: 'PUT', url: `/scenarios/${id}`, payload: { draft: { title: 'x' } } },
      { method: 'DELETE', url: `/scenarios/${id}` },
    ] as const) {
      const res = await t.app.inject({ ...req, cookies: b.cookies });
      expect(res.statusCode).toBe(404);
    }
    // 一般の詳細・一覧にも出ない
    const detail = await t.app.inject({
      method: 'GET',
      url: `/scenarios/${id}`,
      cookies: b.cookies,
    });
    expect(detail.statusCode).toBe(404);
    const avail = await t.app.inject({
      method: 'GET',
      url: '/scenarios/available',
      cookies: b.cookies,
    });
    expect(avail.json().scenarios.some((s: { id: string }) => s.id === id)).toBe(false);
  });

  it('下書きを削除できる。未ログインは拒否される', async () => {
    const { cookies } = await login();
    const created = await t.app.inject({ method: 'POST', url: '/scenarios', cookies, payload: {} });
    const id = created.json().scenario.id as string;
    expect(
      (await t.app.inject({ method: 'DELETE', url: `/scenarios/${id}`, cookies })).statusCode,
    ).toBe(204);
    expect(
      (await t.app.inject({ method: 'GET', url: `/me/scenarios/${id}`, cookies })).statusCode,
    ).toBe(404);
    expect(
      (await t.app.inject({ method: 'POST', url: '/scenarios', payload: {} })).statusCode,
    ).toBe(401);
  });

  it('公開済みのシナリオは編集・削除できない', async () => {
    const { cookies, userId } = await login();
    const s = await t.db.scenario.create({
      data: {
        authorId: userId,
        title: '公開済み',
        summary: '',
        introText: '',
        endingText: '',
        status: 'published',
      },
    });
    const put = await t.app.inject({
      method: 'PUT',
      url: `/scenarios/${s.id}`,
      cookies,
      payload: { draft: { title: '書き換え' } },
    });
    expect(put.statusCode).toBe(409);
    const del = await t.app.inject({ method: 'DELETE', url: `/scenarios/${s.id}`, cookies });
    expect(del.statusCode).toBe(404);
  });

  it('下書きの件数と大きさに上限がある', async () => {
    const { cookies, userId } = await login();
    const big = await t.app.inject({
      method: 'POST',
      url: '/scenarios',
      cookies,
      payload: { draft: { introText: 'あ'.repeat(CONFIG.DRAFT_MAX_CHARS) } },
    });
    expect(big.statusCode).toBe(413);

    await t.db.scenario.createMany({
      data: Array.from({ length: CONFIG.DRAFT_MAX_COUNT }, () => ({
        authorId: userId,
        title: '下書き',
        summary: '',
        introText: '',
        endingText: '',
      })),
    });
    const over = await t.app.inject({ method: 'POST', url: '/scenarios', cookies, payload: {} });
    expect(over.statusCode).toBe(409);
  });
});
