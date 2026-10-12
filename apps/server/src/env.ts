export const env = {
  port: Number(process.env.PORT ?? 3001),
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://mm:mm@localhost:5432/mm',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  /** WebSocket 接続を許可する画面のオリジン（カンマ区切り） */
  webOrigins: (process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(',').map((s) => s.trim()),
  isProduction: process.env.NODE_ENV === 'production',
};
