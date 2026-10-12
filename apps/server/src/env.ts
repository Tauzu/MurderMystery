export const env = {
  port: Number(process.env.PORT ?? 3001),
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://mm:mm@localhost:5432/mm',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  isProduction: process.env.NODE_ENV === 'production',
};
