/**
 * シナリオの勝敗バランスの測定。全席をNPCにした対戦を複数回行い、探偵側の勝率を出す。
 * 使い方: pnpm --filter @mm/server eval:balance [シナリオJSON] [--games=6] [--rounds=2] [--model=...]
 * 犯人が不利すぎないか（探偵側の勝率が高すぎないか）を、シナリオを直す前後で比べるために使う。
 * ANTHROPIC_API_KEY が必要（費用が発生する。1ゲームあたり約13万トークン）。
 */
import { readFileSync } from 'node:fs';
import { createRoom, projectView, reduce, type RoomEvent, type RoomState } from '@mm/game-core';
import {
  Budget,
  createAnthropicClient,
  decidePick,
  decideTalk,
  decideVote,
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
const games = Number(flag('games', '6'));
const rounds = Number(flag('rounds', '2'));
const model = flag('model', CONFIG.NPC_MODEL);

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error('ANTHROPIC_API_KEY が設定されていません');
const llm = createAnthropicClient(apiKey);

const content = scenarioContentSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
const scenario = {
  introText: content.introText,
  endingText: content.endingText,
  characters: content.characters.map((c, i) => ({
    id: `c${i}`,
    name: c.name,
    publicProfile: c.publicProfile,
    situationText: c.situationText,
    isCulprit: c.isCulprit,
    cards: c.cards.map((card, k) => ({ id: `c${i}-k${k}`, title: card.title, body: card.body })),
  })),
};

interface Outcome {
  winner: 'detectives' | 'culprit';
  culprit: string;
  tally: Record<string, number>;
  /** 犯人に投票しなかった探偵側の、投票先と理由 */
  misses: string[];
  tokens: number;
}

async function playGame(): Promise<Outcome> {
  const budget = new Budget(Number.MAX_SAFE_INTEGER);
  const deps: NpcDeps = { llm, budget, rng: Math.random, model };
  let now = 1_800_000_000_000;
  let state: RoomState = createRoom(
    {
      scenario,
      // 操作はこのスクリプトが行うため、人間の席として作る
      participants: Array.from({ length: 4 }, (_, i) => ({
        kind: 'human' as const,
        userId: `eval-${i}`,
      })),
    },
    { now, rng: Math.random },
  );
  const send = (event: RoomEvent) => {
    const r = reduce(state, event, { now, rng: Math.random });
    if (r.error) throw new Error(`${event.type}: ${r.error.code}`);
    state = r.state;
  };
  const nameOf = (seat: number) =>
    state.scenario.characters.find((c) => c.id === state.seats[seat]!.characterId)!.name;
  const view = (seat: number) => projectView(state, seat, now);

  for (let i = 0; i < 2; i++) for (const s of state.seats) send({ type: 'Ready', seat: s.index });
  for (let set = 1; set <= 3; set++) {
    for (const s of state.seats) {
      const d = await decidePick(deps, view(s.index));
      send({ type: 'PickCard', seat: s.index, cardId: d.cardId });
    }
    send({ type: 'Tick' });
    for (let round = 0; round < rounds; round++) {
      for (const s of state.seats) {
        const d = await decideTalk(deps, view(s.index));
        if (!d) continue;
        now += 5_000;
        send({ type: 'Chat', seat: s.index, body: d.say });
      }
    }
    for (const s of state.seats) send({ type: 'AgreeEndTalk', seat: s.index });
    send({ type: 'Tick' });
  }

  const culpritSeat = state.seats.find(
    (s) => state.scenario.characters.find((c) => c.id === s.characterId)!.isCulprit,
  )!.index;
  const misses: string[] = [];
  for (const s of state.seats) {
    const d = await decideVote(deps, view(s.index));
    send({ type: 'Vote', seat: s.index, target: d.target });
    if (s.index !== culpritSeat && d.target !== culpritSeat) {
      misses.push(`${nameOf(s.index)}→${nameOf(d.target)}：${d.reason ?? '（理由なし）'}`);
    }
  }
  send({ type: 'Tick' });
  const result = state.result!;
  return {
    winner: result.winner,
    culprit: nameOf(culpritSeat),
    tally: Object.fromEntries(result.tally.map((n, i) => [nameOf(i), n])),
    misses,
    tokens: budget.usedTokens,
  };
}

console.log(
  `# 勝敗バランス  model=${model}  games=${games}  rounds=${rounds}\nシナリオ: ${file}\n`,
);
const outcomes = await Promise.all(
  Array.from({ length: games }, () =>
    playGame().catch((e: unknown) => {
      console.warn('  ! ゲームが失敗:', e instanceof Error ? e.message : e);
      return null;
    }),
  ),
);
const done = outcomes.filter((o): o is Outcome => o !== null);
done.forEach((o, i) => {
  const votes = Object.entries(o.tally)
    .map(([n, v]) => `${n}${v}`)
    .join(' ');
  console.log(
    `${i + 1}. ${o.winner === 'detectives' ? '探偵側の勝ち' : '犯人の勝ち  '}  犯人=${o.culprit}  得票: ${votes}`,
  );
  o.misses.forEach((m) => console.log(`     犯人に入れなかった: ${m}`));
});
const wins = done.filter((o) => o.winner === 'detectives').length;
console.log(
  `\n探偵側の勝率: ${wins}/${done.length}（${Math.round((100 * wins) / Math.max(1, done.length))}%）`,
);
console.log(`トークン合計: ${done.reduce((s, o) => s + o.tokens, 0)}`);
