/**
 * シナリオのAIチェックを、実際のAIで試す。
 * 使い方: pnpm --filter @mm/server eval:check <シナリオJSON> [--model=...]
 * 不適切表現と整合性の結果を表示する。ANTHROPIC_API_KEY が必要（.env から読む）。
 */
import { readFileSync } from 'node:fs';
import { createAnthropicClient, runScenarioCheck } from '@mm/npc';
import {
  checkScenarioStructure,
  CONSISTENCY_LABELS,
  MODERATION_LABELS,
  scenarioContentSchema,
} from '@mm/shared';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // .env が無い場合は環境変数をそのまま使う
}

const file = process.argv.find((a, i) => i >= 2 && !a.startsWith('--'));
const model = process.argv.find((a) => a.startsWith('--model='))?.slice('--model='.length);
const apiKey = process.env.ANTHROPIC_API_KEY;
if (!file || !apiKey) {
  console.error('使い方: eval:check <シナリオJSON> （ANTHROPIC_API_KEY が必要）');
  process.exit(1);
}

const raw: unknown = JSON.parse(readFileSync(file, 'utf-8'));
const issues = checkScenarioStructure(raw);
if (issues.length > 0) {
  console.error('構造チェックで不合格:');
  for (const i of issues) console.error(`- ${i.message}`);
  process.exit(1);
}
const content = scenarioContentSchema.parse(raw);

let inputTokens = 0;
let outputTokens = 0;
const base = createAnthropicClient(apiKey);
const llm = {
  async complete(req: Parameters<typeof base.complete>[0]) {
    const res = await base.complete(req);
    inputTokens += res.inputTokens;
    outputTokens += res.outputTokens;
    return res;
  },
};

const started = Date.now();
const { moderation, consistency } = await runScenarioCheck({ llm, model }, content);
console.log(
  `所要時間 ${((Date.now() - started) / 1000).toFixed(1)}秒、トークン 入力${inputTokens} 出力${outputTokens}`,
);
console.log(`\n不適切表現：${moderation.ok ? '指摘なし' : '指摘あり（公開不可）'}`);
for (const f of moderation.flags) {
  console.log(`- [${MODERATION_LABELS[f.category]}] ${f.where} … ${f.reason}`);
}
console.log(
  `\n整合性：${consistency.verdict === 'ok' ? '指摘なし' : `指摘 ${consistency.findings.length} 件`}`,
);
for (const f of consistency.findings) {
  console.log(`- [${CONSISTENCY_LABELS[f.aspect]}] ${f.message}`);
}
