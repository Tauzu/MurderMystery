import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { buildApp } from './app';
import { createDb } from './db';
import { env } from './env';

/** 実DB・実Redis（docker compose）に接続するテスト用アプリ。 */
export function createTestApp() {
  const db = createDb(env.databaseUrl);
  const redis = new Redis(env.redisUrl);
  const app = buildApp({ db, redis });
  return {
    app,
    db,
    redis,
    async close() {
      await app.close();
      await db.$disconnect();
      redis.disconnect();
    },
  };
}

const RUN_ID = randomUUID().slice(0, 8);
let counter = 0;
/** テスト間で重複しないメールアドレス。後片付けは cleanupTestUsers で行う。 */
export function uniqueEmail() {
  counter += 1;
  return `test-${RUN_ID}-${counter}@example.test`;
}

export async function cleanupTestUsers(db: ReturnType<typeof createDb>) {
  await db.user.deleteMany({ where: { email: { startsWith: `test-${RUN_ID}-` } } });
}

export function sessionCookie(res: {
  cookies: { name: string; value: string }[];
}): Record<string, string> {
  const c = res.cookies.find((x) => x.name === 'mm_session');
  return c ? { mm_session: c.value } : {};
}

/** パスワード無しのテストユーザーを直接作る（ルーム操作のテスト用）。 */
export async function createTestUser(db: ReturnType<typeof createDb>) {
  const user = await db.user.create({
    data: { email: uniqueEmail(), displayName: 'テスター', agreedAgeAt: new Date() },
  });
  return user.id;
}
