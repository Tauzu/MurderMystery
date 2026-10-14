import { createAnthropicClient } from '@mm/npc';
import { Redis } from 'ioredis';
import { buildApp } from './app';
import { createDb } from './db';
import { NpcEngine } from './game/npc-engine';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // .env が無い場合は環境変数をそのまま使う
}

// .env の読み込み後に評価させるため、動的 import にする
const { env } = await import('./env');

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.warn(
    'ANTHROPIC_API_KEY が未設定です。NPCは発言せず、カード公開と投票だけランダムに行います',
  );
}
const npc = apiKey
  ? new NpcEngine({
      llm: createAnthropicClient(apiKey),
      log: (message, error) =>
        console.warn(message, error instanceof Error ? error.message : error),
    })
  : undefined;

const app = buildApp({
  db: createDb(env.databaseUrl),
  redis: new Redis(env.redisUrl),
  secureCookies: env.isProduction,
  autoTick: true,
  npc,
  idleSwitchSec: env.idleSwitchSec,
  // 警告は切替の30秒前（既定の 150秒/180秒 と同じ間隔）
  idleWarnSec: env.idleSwitchSec === undefined ? undefined : Math.max(0, env.idleSwitchSec - 30),
});

const restored = await app.deps.rooms.restoreAll();
if (restored > 0) console.log(`ルームを ${restored} 件復元しました`);

await app.listen({ port: env.port, host: '0.0.0.0' });
console.log(`server listening on :${env.port}`);
