import type { RoomView } from '@mm/game-core';
import { CONFIG } from '@mm/shared';
import type { Budget } from './budget';
import type { LlmClient } from './llm';
import { pickPrompt, systemPrompt, talkPrompt, votePrompt } from './prompt';

export interface NpcDeps {
  llm: LlmClient;
  budget: Budget;
  rng: () => number;
  model?: string;
  /** その席の性格（プロンプトに加える）。省略可 */
  persona?: string;
  /** 失敗の記録など。省略可 */
  onError?: (label: string, error: unknown) => void;
  /** AIの代わりに定型文・ランダム選択を使った理由の記録。省略可 */
  onFallback?: (label: string, reason: string) => void;
}

export type Source = 'ai' | 'fallback';

/** 予算切れや形式不正が続いたときにつなぐ定型文。 */
export const FILLER_LINES = [
  '少し考えさせてください。',
  'ここまでの話を整理しています。',
  'もう少し皆さんの話を聞かせてください。',
  'なるほど……。気になる点がいくつかあります。',
];

const pick = <T>(items: readonly T[], rng: () => number): T =>
  items[Math.floor(rng() * items.length)]!;

/** 返答から最初のJSONオブジェクトを取り出す（前後に説明文が付いても読めるように）。 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * 発言が、自分の非公開の状況文を丸写ししていないか。
 * 状況文の連続した minLen 文字以上が含まれていれば true。設計書 §8.5。
 */
export function copiesSecret(say: string, secret: string, minLen = 20): boolean {
  if (secret.length < minLen) return false;
  for (let i = 0; i + minLen <= secret.length; i++) {
    if (say.includes(secret.slice(i, i + minLen))) return true;
  }
  return false;
}

/** 文字2つ組の重なり具合（0〜1）。記号・空白は無視する。 */
export function similarity(a: string, b: string): number {
  const grams = (s: string) => {
    const t = s.replace(/[\s、。，．,.!！?？「」『』…・ー-]/g, '');
    const set = new Set<string>();
    for (let i = 0; i + 2 <= t.length; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const x = grams(a);
  const y = grams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let common = 0;
  for (const g of x) if (y.has(g)) common++;
  return (2 * common) / (x.size + y.size);
}

/** 自分の直近の発言とほぼ同じ内容か。 */
export function repeatsOwn(say: string, view: RoomView, threshold = 0.5): boolean {
  return view.chat
    .filter((m) => m.seat === view.me.seat)
    .slice(-3)
    .some((m) => similarity(say, m.body) >= threshold);
}

async function call(deps: NpcDeps, view: RoomView, user: string) {
  const res = await deps.llm.complete({
    model: deps.model ?? CONFIG.NPC_MODEL,
    system: systemPrompt(view.me.isCulprit, deps.persona),
    user,
    maxTokens: CONFIG.NPC_MAX_OUTPUT_TOKENS,
    timeoutMs: CONFIG.NPC_AI_TIMEOUT_SEC * 1000,
  });
  deps.budget.add(res.inputTokens, res.outputTokens);
  return res.text;
}

/**
 * 次の発言を決める。
 * - 予算切れ、または形式不正・丸写しが2回続いたときは定型文でつなぐ。
 * - API失敗・タイムアウトのときは null（今回は発言せず、予定を組み直す）。設計書 §8.7。
 */
export async function decideTalk(
  deps: NpcDeps,
  view: RoomView,
): Promise<{ say: string; source: Source } | null> {
  const filler = { say: pick(FILLER_LINES, deps.rng), source: 'fallback' as const };
  if (deps.budget.exhausted) {
    deps.onFallback?.('talk', '予算切れ');
    return filler;
  }

  let reason = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    // 2回目は、直前の発言との重複を避けるよう強く指示する
    const user = talkPrompt(view, attempt > 0);
    let text: string;
    try {
      text = await call(deps, view, user);
    } catch (e) {
      deps.onError?.('talk', e);
      return null;
    }
    const say = parseJsonObject(text)?.say;
    if (typeof say !== 'string') {
      reason = '返答がJSONの形式でない';
      continue;
    }
    const trimmed = say.trim().slice(0, CONFIG.NPC_MAX_CHARS);
    if (trimmed.length === 0) reason = '発言が空';
    else if (copiesSecret(trimmed, view.me.situationText)) reason = '状況文の丸写し';
    else if (repeatsOwn(trimmed, view)) reason = '自分の発言と重複';
    else return { say: trimmed, source: 'ai' };
  }
  deps.onFallback?.('talk', `2回続けて使えない返答（${reason}）`);
  return filler;
}

/** 公開するカードを選ぶ。失敗時は未公開カードからランダム。 */
export async function decidePick(
  deps: NpcDeps,
  view: RoomView,
): Promise<{ cardId: string; source: Source }> {
  const open = view.me.cards.filter((c) => !c.revealed);
  const fallback = { cardId: pick(open, deps.rng).id, source: 'fallback' as const };
  if (deps.budget.exhausted || open.length === 1) {
    return open.length === 1 ? { cardId: open[0]!.id, source: 'fallback' } : fallback;
  }
  try {
    const cardId = parseJsonObject(await call(deps, view, pickPrompt(view)))?.cardId;
    if (typeof cardId === 'string' && open.some((c) => c.id === cardId)) {
      return { cardId, source: 'ai' };
    }
  } catch (e) {
    deps.onError?.('pick', e);
  }
  return fallback;
}

/** 発言の中で名前を挙げられた回数が最も多い、自分以外の席。同数ならランダム。 */
export function mostMentionedSeat(view: RoomView, rng: () => number): number {
  const others = view.seats.filter((s) => s.seat !== view.me.seat);
  const counts = others.map((s) => ({
    seat: s.seat,
    n: view.chat
      .filter((m) => m.seat !== s.seat)
      .reduce((sum, m) => sum + (m.body.includes(s.name) ? 1 : 0), 0),
  }));
  const max = Math.max(...counts.map((c) => c.n));
  return pick(
    counts.filter((c) => c.n === max),
    rng,
  ).seat;
}

/** 投票先を決める。失敗時は、最も名指しされた人。 */
export async function decideVote(
  deps: NpcDeps,
  view: RoomView,
): Promise<{ target: number; reason?: string; source: Source }> {
  const fallback = { target: mostMentionedSeat(view, deps.rng), source: 'fallback' as const };
  if (deps.budget.exhausted) return fallback;
  try {
    const obj = parseJsonObject(await call(deps, view, votePrompt(view)));
    const target = obj?.target;
    if (
      typeof target === 'number' &&
      Number.isInteger(target) &&
      target !== view.me.seat &&
      view.seats.some((s) => s.seat === target)
    ) {
      return {
        target,
        reason: typeof obj?.reason === 'string' ? obj.reason : undefined,
        source: 'ai',
      };
    }
  } catch (e) {
    deps.onError?.('vote', e);
  }
  return fallback;
}
