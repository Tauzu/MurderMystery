import { fileURLToPath } from 'node:url';
import { createDb } from '../src/db';
import { env } from '../src/env';
import { seedScenarios } from '../src/seed';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // .env が無い場合は環境変数をそのまま使う
}

const db = createDb(process.env.DATABASE_URL ?? env.databaseUrl);
const dir = fileURLToPath(new URL('../../../scenarios', import.meta.url));

const replace = process.argv.includes('--replace');
if (replace && process.env.NODE_ENV === 'production') {
  throw new Error('--replace は本番では使えません');
}

try {
  const { created, skipped } = await seedScenarios(db, dir, { replace });
  console.log(
    `登録: ${created.join(', ') || '(なし)'} / 登録済みのためスキップ: ${skipped.join(', ') || '(なし)'}`,
  );
} finally {
  await db.$disconnect();
}
