/**
 * NPCの品質評価。全席をNPCにして、実際のAIで1ゲームを最後まで進める。
 * 使い方: pnpm --filter @mm/server eval:npc [シナリオJSON] [--rounds=2] [--model=...]
 * ANTHROPIC_API_KEY が必要（.env から読む）。結果は標準出力に出す。
 */
import { readFileSync } from 'node:fs';
import { createRoom, projectView, reduce, type RoomEvent, type RoomState } from '@mm/game-core';
import {
  Budget,
  copiesSecret,
  createAnthropicClient,
  decidePick,
  decideTalk,
  decideVote,
  type LlmClient,
  type NpcDeps,
} from '@mm/npc';
import { CONFIG, scenarioContentSchema } from '@mm/shared';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // .env が無い場合は環境変数をそのまま使う
}

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const file =
  args.find((a) => !a.startsWith('--')) ??
  new URL('../../../scenarios/001-yukiyama-sansou.json', import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/,
    '$1',
  );
const rounds = Number(flag('rounds', '2'));
const model = flag('model', CONFIG.NPC_MODEL);

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error('ANTHROPIC_API_KEY が設定されていません');

const content = scenarioContentSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
const scenario = {
  introText: content.introText,
  endingText: content.endingText,
  victim: content.victimName
    ? { name: content.victimName, profile: content.victimProfile ?? '' }
    : null,
  characters: content.characters.map((c, i) => ({
    id: `c${i}`,
    name: c.name,
    publicProfile: c.publicProfile,
    situationText: c.situationText,
    isCulprit: c.isCulprit,
    cards: c.cards.map((card, k) => ({
      id: `c${i}-k${k}`,
      kind: card.kind,
      title: card.title,
      body: card.body,
      isFabricated: card.isFabricated ?? false,
    })),
  })),
};

// 呼び出し回数・所要時間を数える
const real = createAnthropicClient(apiKey);
const stats = { calls: 0, ms: 0, errors: 0 };
const llm: LlmClient = {
  async complete(req) {
    const t = Date.now();
    stats.calls++;
    try {
      const res = await real.complete(req);
      if (args.includes('--raw')) console.log('  RAW:', JSON.stringify(res.text).slice(0, 400));
      return res;
    } catch (e) {
      stats.errors++;
      throw e;
    } finally {
      stats.ms += Date.now() - t;
    }
  },
};
const budget = new Budget(Number.MAX_SAFE_INTEGER);
const fallbacks: string[] = [];
const deps: NpcDeps = {
  llm,
  budget,
  rng: Math.random,
  model,
  onError: (label, e) => console.warn(`  ! ${label} 失敗:`, e instanceof Error ? e.message : e),
};

let now = 1_800_000_000_000;
let state: RoomState = createRoom(
  {
    scenario, // 人間の席として作り、操作はこのスクリプトが行う（全員NPCだと会話が始まった瞬間に終わるため）
    participants: Array.from({ length: 4 }, (_, i) => ({
      kind: 'human' as const,
      userId: `eval-${i}`,
    })),
  },
  { now, rng: Math.random },
);

function send(event: RoomEvent) {
  const r = reduce(state, event, { now, rng: Math.random });
  if (r.error) throw new Error(`${event.type}: ${r.error.code} ${r.error.message}`);
  state = r.state;
}
const nameOf = (seat: number) =>
  state.scenario.characters.find((c) => c.id === state.seats[seat]!.characterId)!.name;
const view = (seat: number) => projectView(state, seat, now);

console.log(`# NPC評価  model=${model}  rounds=${rounds}  シナリオ=${file}`);
const culprit = state.seats.find(
  (s) => state.scenario.characters.find((c) => c.id === s.characterId)!.isCulprit,
)!;
console.log(`犯人: 席${culprit.index} ${nameOf(culprit.index)}\n`);

for (let phase = 0; phase < 2; phase++) {
  for (const seat of state.seats) send({ type: 'Ready', seat: seat.index });
}

for (let set = 1; set <= 3; set++) {
  if (state.phase !== 'REVEAL') throw new Error(`REVEAL のはずが ${state.phase}`);
  console.log(`## 第${set}回`);
  for (const seat of state.seats) {
    const d = await decidePick(deps, view(seat.index));
    if (d.source === 'fallback') fallbacks.push(`pick 席${seat.index}`);
    send({ type: 'PickCard', seat: seat.index, cardId: d.cardId });
  }
  send({ type: 'Tick' });
  for (const r of state.revealed.filter((x) => x.setNo === set)) {
    const card = state.scenario.characters.flatMap((c) => c.cards).find((c) => c.id === r.cardId)!;
    console.log(`  [公開] ${nameOf(r.seat)}「${card.title}」`);
  }
  for (let round = 0; round < rounds; round++) {
    for (const seat of state.seats) {
      const d = await decideTalk(deps, view(seat.index));
      if (!d) {
        fallbacks.push(`talk 席${seat.index} (API失敗)`);
        continue;
      }
      if (d.source === 'fallback') fallbacks.push(`talk 席${seat.index} (定型文)`);
      now += 5_000;
      send({ type: 'Chat', seat: seat.index, body: d.say });
      console.log(
        `  ${nameOf(seat.index)}${seat.index === culprit.index ? '【犯人】' : ''}：${d.say}`,
      );
    }
  }
  for (const seat of state.seats) send({ type: 'AgreeEndTalk', seat: seat.index });
  send({ type: 'Tick' });
}

console.log('\n## 投票');
for (const seat of state.seats) {
  const d = await decideVote(deps, view(seat.index));
  if (d.source === 'fallback') fallbacks.push(`vote 席${seat.index}`);
  send({ type: 'Vote', seat: seat.index, target: d.target });
  console.log(`  ${nameOf(seat.index)} → ${nameOf(d.target)}  (${d.source}) ${d.reason ?? ''}`);
}
send({ type: 'Tick' });
const result = state.result!;
console.log(
  `\n結果: ${result.winner === 'detectives' ? '探偵側の勝ち' : '犯人の勝ち'}  得票=${result.tally.join(',')}`,
);

// ---- 自動チェック ----
console.log('\n## 自動チェック');
const problems: string[] = [];
const windowHit = (text: string, secret: string, n = 12) => {
  for (let i = 0; i + n <= secret.length; i++)
    if (text.includes(secret.slice(i, i + n))) return true;
  return false;
};
for (const m of state.chat) {
  const who = nameOf(m.seat);
  const chars = state.scenario.characters;
  const mine = chars.find((c) => c.id === state.seats[m.seat]!.characterId)!;
  if (m.body.length > CONFIG.NPC_MAX_CHARS) problems.push(`長すぎ: ${who}`);
  if (/AI|プロンプト|システム|NPC|モデル|言語モデル/.test(m.body))
    problems.push(`メタ発言: ${who}「${m.body}」`);
  if (copiesSecret(m.body, mine.situationText)) problems.push(`状況文の丸写し: ${who}`);
  if (mine.isCulprit && /私が(犯人|殺)/.test(m.body))
    problems.push(`犯人が自白: ${who}「${m.body}」`);
  for (const other of chars.filter((c) => c.id !== mine.id)) {
    const revealed = new Set(state.revealed.map((r) => r.cardId));
    const secrets = [
      other.situationText,
      ...other.cards
        // 犯人は、他人の手札にある捏造カードを知っている（仕様書 §4.3.1）
        .filter((c) => !revealed.has(c.id) && !(c.isFabricated && mine.isCulprit))
        .map((c) => c.body),
    ];
    if (secrets.some((s) => windowHit(m.body, s)))
      problems.push(`他人の秘密に酷似: ${who}「${m.body}」`);
  }
}
console.log(
  problems.length ? problems.map((p) => `  ✗ ${p}`).join('\n') : '  ✓ 問題は検出されませんでした',
);
console.log(
  `\nAI呼び出し: ${stats.calls}回（失敗${stats.errors}）、平均${Math.round(stats.ms / Math.max(1, stats.calls))}ms`,
);
console.log(`トークン: ${budget.usedTokens}（予算 ${CONFIG.NPC_BUDGET_TOKENS}）`);
console.log(`フォールバック: ${fallbacks.length}件 ${fallbacks.join(', ')}`);
