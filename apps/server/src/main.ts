import { Redis } from 'ioredis';
import { buildApp } from './app';
import { createDb } from './db';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // .env が無い場合は環境変数をそのまま使う
}

// .env の読み込み後に評価させるため、動的 import にする
const { env } = await import('./env');

const app = buildApp({
  db: createDb(env.databaseUrl),
  redis: new Redis(env.redisUrl),
  secureCookies: env.isProduction,
  autoTick: true,
});

const restored = await app.deps.rooms.restoreAll();
if (restored > 0) console.log(`ルームを ${restored} 件復元しました`);

await app.listen({ port: env.port, host: '0.0.0.0' });
console.log(`server listening on :${env.port}`);
