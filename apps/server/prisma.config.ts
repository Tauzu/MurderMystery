import { defineConfig } from 'prisma/config';

// Prisma 7 は .env を自動で読み込まないため、ルートの .env を明示的に読む。
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url));
} catch {
  // .env が無い場合（CIなど）は環境変数をそのまま使う
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
  datasource: { url: process.env.DATABASE_URL ?? 'postgresql://mm:mm@localhost:5432/mm' },
});
