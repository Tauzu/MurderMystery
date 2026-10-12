import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import type { Db } from './db';
import { Matchmaker } from './game/matchmaker';
import type { NpcEngine } from './game/npc-engine';
import { RoomManager } from './game/room-manager';
import { authRoutes } from './routes/auth';
import { matchRoutes } from './routes/matches';
import { scenarioRoutes } from './routes/scenarios';
import { wsRoutes } from './routes/ws';
import { SESSION_COOKIE, getSessionUserId } from './session';

export interface AppOptions {
  db: Db;
  redis: Redis;
  secureCookies?: boolean;
  /** 本番では true。テストでは手動で rooms.tickAll() を呼ぶ */
  autoTick?: boolean;
  now?: () => number;
  rng?: () => number;
  /** NPC席の行動を決めるエンジン（AIを使う場合） */
  npc?: NpcEngine;
}

export interface AppDeps {
  db: Db;
  redis: Redis;
  secureCookies?: boolean;
  rooms: RoomManager;
  matchmaker: Matchmaker;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
    /** ログイン中ならユーザーIDを返し、未ログインなら401を返して null を返す */
    requireUserId(request: FastifyRequest, reply: FastifyReply): Promise<string | null>;
  }
}

export function buildApp(opts: AppOptions) {
  const app = Fastify({ logger: false });

  const rooms = new RoomManager({
    db: opts.db,
    redis: opts.redis,
    autoTick: opts.autoTick,
    now: opts.now,
    rng: opts.rng,
    npc: opts.npc,
  });
  const deps: AppDeps = {
    db: opts.db,
    redis: opts.redis,
    secureCookies: opts.secureCookies,
    rooms,
    matchmaker: new Matchmaker(opts.db, rooms),
  };

  app.register(cookie);
  app.register(websocket);
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
  app.addHook('onClose', async () => rooms.shutdown());

  app.get('/health', async () => ({ status: 'ok' }));
  app.register(authRoutes);
  app.register(scenarioRoutes);
  app.register(matchRoutes);
  app.register(wsRoutes);

  return app;
}
