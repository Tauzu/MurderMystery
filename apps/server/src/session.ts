import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

export const SESSION_COOKIE = 'mm_session';
export const SESSION_TTL_SEC = 60 * 60 * 24 * 7;

const key = (id: string) => `session:${id}`;

export async function createSession(redis: Redis, userId: string): Promise<string> {
  const id = randomBytes(32).toString('base64url');
  await redis.set(key(id), userId, 'EX', SESSION_TTL_SEC);
  return id;
}

export async function getSessionUserId(redis: Redis, id: string): Promise<string | null> {
  return redis.get(key(id));
}

export async function destroySession(redis: Redis, id: string): Promise<void> {
  await redis.del(key(id));
}
