export const env = {
  port: Number(process.env.PORT ?? 3001),
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://mm:mm@localhost:5432/mm',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  /** WebSocket 接続を許可する画面のオリジン（カンマ区切り） */
  webOrigins: (process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(',').map((s) => s.trim()),
  /** 無操作でNPCに切り替わるまでの秒数。テストプレイで延ばす用。未設定なら既定値（3分） */
  idleSwitchSec: process.env.IDLE_SWITCH_SEC ? Number(process.env.IDLE_SWITCH_SEC) : undefined,
  isProduction: process.env.NODE_ENV === 'production',
};
