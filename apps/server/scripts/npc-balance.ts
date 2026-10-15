/**
 * シナリオの勝敗バランスの測定。全席をNPCにした対戦を複数回行い、探偵側の勝率を出す。
 * 使い方: pnpm --filter @mm/server eval:balance [シナリオJSON] [--games=6] [--rounds=2] [--parallel=2] [--no-persona] [--model=...]
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
  pickPersona,
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
const games = Number(flag('games', '6'));
const rounds = Number(flag('rounds', '2'));
const model = flag('model', CONFIG.NPC_MODEL);

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error('ANTHROPIC_API_KEY が設定されていません');
const raw = createAnthropicClient(apiKey);
/** レート制限（429）のときは待って再試行する。測定の結果がAIの失敗で歪まないようにするため */
const llm: LlmClient = {
  async complete(req) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await raw.complete(req);
      } catch (e) {
        const rateLimited = e instanceof Error && e.message.startsWith('429');
        if (!rateLimited || attempt >= 8) throw e;
        await new Promise((r) => setTimeout(r, 3000 + Math.random() * 5000));
      }
    }
  },
};

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

/** 席ごとの性格。--no-persona のときは付けない */
const state0Personas = () =>
  Array.from({ length: 4 }, () =>
    args.includes('--no-persona') ? undefined : pickPersona(Math.random).text,
  );

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
  const personas = state0Personas();
  const depsOf = (seat: number): NpcDeps => ({
    llm,
    budget,
    rng: Math.random,
    model,
    persona: personas[seat],
    onError: (label, e) =>
      console.warn(`  ! ${label} 失敗:`, e instanceof Error ? e.message.slice(0, 160) : e),
  });
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
      const d = await decidePick(depsOf(s.index), view(s.index));
      send({ type: 'PickCard', seat: s.index, cardId: d.cardId });
    }
    send({ type: 'Tick' });
    for (let round = 0; round < rounds; round++) {
      for (const s of state.seats) {
        const d = await decideTalk(depsOf(s.index), view(s.index));
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
    const d = await decideVote(depsOf(s.index), view(s.index));
    send({ type: 'Vote', seat: s.index, target: d.target });
    if (s.index !== culpritSeat && d.target !== culpritSeat) {
      misses.push(
        `${nameOf(s.index)}→${nameOf(d.target)}[${d.source}]：${d.reason ?? '（理由なし）'}`,
      );
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
// 同時に進めるゲーム数。多いとAPIのレート制限に当たる
const parallel = Number(flag('parallel', '2'));
const outcomes: (Outcome | null)[] = new Array(games).fill(null);
let next = 0;
await Promise.all(
  Array.from({ length: parallel }, async () => {
    while (next < games) {
      const i = next++;
      try {
        outcomes[i] = await playGame();
      } catch (e) {
        console.warn('  ! ゲームが失敗:', e instanceof Error ? e.message : e);
      }
    }
  }),
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
