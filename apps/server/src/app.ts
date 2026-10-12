import cookie from '@fastify/cookie';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import type { Db } from './db';
import { authRoutes } from './routes/auth';
import { scenarioRoutes } from './routes/scenarios';
import { SESSION_COOKIE, getSessionUserId } from './session';

export interface AppDeps {
  db: Db;
  redis: Redis;
  secureCookies?: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
    /** ログイン中ならユーザーIDを返し、未ログインなら401を返して null を返す */
    requireUserId(request: FastifyRequest, reply: FastifyReply): Promise<string | null>;
  }
}

export function buildApp(deps: AppDeps) {
  const app = Fastify({ logger: false });

  app.register(cookie);
  app.decorate('deps', deps);
  app.decorate('requireUserId', async (request: FastifyRequest, reply: FastifyReply) => {
    const sid = request.cookies[SESSION_COOKIE];
    const userId = sid ? await getSessionUserId(deps.redis, sid) : null;
    if (!userId) {
      await reply.code(401).send({ code: 'unauthorized', message: 'ログインが必要です' });
      return null;
    }
    return userId;
  });

  app.get('/health', async () => ({ status: 'ok' }));
  app.register(authRoutes);
  app.register(scenarioRoutes);

  return app;
}
