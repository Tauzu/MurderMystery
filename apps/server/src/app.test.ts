import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTestUsers, createTestApp, sessionCookie, uniqueEmail } from './test-helpers';

const t = createTestApp();
afterAll(async () => {
  await cleanupTestUsers(t.db);
  await t.close();
});

describe('GET /health', () => {
  it('200 と status:ok を返す', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('認証', () => {
  const password = 'correct-horse-battery';
  const body = (email: string) => ({ email, password, displayName: 'テスター', agreeAge: true });

  it('登録するとセッションが開始され、/me で自分が取得できる', async () => {
    const email = uniqueEmail();
    const res = await t.app.inject({ method: 'POST', url: '/auth/register', payload: body(email) });
    expect(res.statusCode).toBe(201);
    const cookie = res.cookies.find((c) => c.name === 'mm_session');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');

    const me = await t.app.inject({ method: 'GET', url: '/me', cookies: sessionCookie(res) });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.displayName).toBe('テスター');
  });

  it('パスワードは平文で保存されない', async () => {
    const email = uniqueEmail();
    await t.app.inject({ method: 'POST', url: '/auth/register', payload: body(email) });
    const user = await t.db.user.findUniqueOrThrow({ where: { email } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toContain(password);
  });

  it('同じメールアドレスでは登録できない（大文字小文字を区別しない）', async () => {
    const email = uniqueEmail();
    await t.app.inject({ method: 'POST', url: '/auth/register', payload: body(email) });
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: body(email.toUpperCase()),
    });
    expect(res.statusCode).toBe(409);
  });

  it('13歳以上の同意がないと登録できない', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { ...body(uniqueEmail()), agreeAge: false },
    });
    expect(res.statusCode).toBe(400);
  });

  it('短すぎるパスワードは拒否される', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { ...body(uniqueEmail()), password: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('ログインできる。パスワードが違えば401', async () => {
    const email = uniqueEmail();
    await t.app.inject({ method: 'POST', url: '/auth/register', payload: body(email) });

    const ok = await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password },
    });
    expect(ok.statusCode).toBe(200);

    const ng = await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'wrong-password' },
    });
    expect(ng.statusCode).toBe(401);

    const unknown = await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: uniqueEmail(), password },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual(ng.json());
  });

  it('ログアウトするとセッションが無効になる', async () => {
    const reg = await t.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: body(uniqueEmail()),
    });
    const cookies = sessionCookie(reg);
    const out = await t.app.inject({ method: 'POST', url: '/auth/logout', cookies });
    expect(out.statusCode).toBe(204);
    const me = await t.app.inject({ method: 'GET', url: '/me', cookies });
    expect(me.statusCode).toBe(401);
  });

  it('停止中のユーザーはログインできない', async () => {
    const email = uniqueEmail();
    await t.app.inject({ method: 'POST', url: '/auth/register', payload: body(email) });
    await t.db.user.update({ where: { email }, data: { status: 'suspended' } });
    const res = await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password },
    });
    expect(res.statusCode).toBe(401);
  });

  it('未ログインでは /me が401', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
  });
});
