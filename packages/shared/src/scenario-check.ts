import type { z } from 'zod';
import { CARDS_PER_CHARACTER, SEAT_COUNT } from './phases';
import { scenarioContentSchema } from './scenario';

export interface ScenarioIssue {
  /** 入力欄の位置（例 ['characters', 0, 'cards', 1, 'title']） */
  path: (string | number)[];
  message: string;
}

const FIELD_LABELS: Record<string, string> = {
  title: 'タイトル',
  summary: '概要',
  introText: '冒頭文',
  endingText: '結末文',
  victimName: '被害者の名前',
  victimProfile: '被害者の設定',
  name: '名前',
  publicProfile: '公開用の設定',
  situationText: '状況文',
  isCulprit: '犯人の指定',
  kind: '種類',
  body: '内容',
};

/** 入力欄の名前（例「キャラクター1の手札2枚目のタイトル」）。 */
export function labelOf(path: readonly PropertyKey[]): string {
  const parts: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    if (key === 'characters' && typeof path[i + 1] === 'number') {
      parts.push(`キャラクター${(path[i + 1] as number) + 1}`);
      i++;
    } else if (key === 'cards' && typeof path[i + 1] === 'number') {
      parts.push(`の手札${(path[i + 1] as number) + 1}枚目`);
      i++;
    } else if (typeof key === 'string') {
      const label = FIELD_LABELS[key];
      if (label) parts.push(parts.length > 0 ? `の${label}` : label);
    }
  }
  return parts.join('') || '入力内容';
}

function describe(issue: z.core.$ZodIssue): string {
  const label = labelOf(issue.path);
  if (issue.code === 'custom') return issue.message;
  const last = issue.path[issue.path.length - 1];
  if (issue.code === 'invalid_type' && (last === 'characters' || last === 'cards')) {
    return last === 'characters'
      ? `キャラクターは${SEAT_COUNT}人入力してください`
      : `${label.replace(/の手札.*$/, '')}の手札は${CARDS_PER_CHARACTER}枚入力してください`;
  }
  if (issue.code === 'invalid_type') {
    return `${label}を入力してください`;
  }
  if (issue.code === 'too_small' || issue.code === 'too_big') {
    const min = issue.code === 'too_small' ? Number(issue.minimum) : undefined;
    const max = issue.code === 'too_big' ? Number(issue.maximum) : undefined;
    if (issue.origin === 'array') {
      if (last === 'characters') return `キャラクターは${SEAT_COUNT}人入力してください`;
      if (last === 'cards')
        return `${label.replace(/の手札.*$/, '')}の手札は${CARDS_PER_CHARACTER}枚入力してください`;
    }
    if (issue.origin === 'string') {
      return issue.code === 'too_small'
        ? `${label}は${min}文字以上で入力してください`
        : `${label}は${max}文字以内で入力してください`;
    }
  }
  return `${label}の入力が正しくありません`;
}

/**
 * 下書きの構造チェック（設計書 §9.2 の1）。入力途中の下書きにも使えるよう、
 * 例外は投げず、直すべき箇所を日本語の指摘にして返す。空配列なら公開できる形。
 */
export function checkScenarioStructure(draft: unknown): ScenarioIssue[] {
  const parsed = scenarioContentSchema.safeParse(draft);
  if (parsed.success) return [];
  const seen = new Set<string>();
  const issues: ScenarioIssue[] = [];
  for (const issue of parsed.error.issues) {
    const message = describe(issue);
    const key = `${issue.path.join('.')}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ path: issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p)), message });
  }
  return issues;
}

/** 不適切表現の分類。仕様書 §6.3 */
export const MODERATION_CATEGORIES = [
  'violence',
  'sexual',
  'defamation',
  'discrimination',
] as const;
export type ModerationCategory = (typeof MODERATION_CATEGORIES)[number];

export const MODERATION_LABELS: Record<ModerationCategory, string> = {
  violence: '過度な残虐描写',
  sexual: '性的表現',
  defamation: '実在の人物・団体への誹謗',
  discrimination: '差別的表現',
};

/** 整合性チェックで見る観点。仕様書 §6.3・設計書 §9.2 */
export const CONSISTENCY_ASPECTS = [
  'situation',
  'culprit',
  'suspects',
  'fabricated',
  'ending',
  'timeline',
] as const;
export type ConsistencyAspect = (typeof CONSISTENCY_ASPECTS)[number];

export const CONSISTENCY_LABELS: Record<ConsistencyAspect, string> = {
  situation: '状況文と手札の対応',
  culprit: '犯人を推理できるか',
  suspects: '犯人以外の容疑者',
  fabricated: '捏造カードを見破れるか',
  ending: '結末文との矛盾',
  timeline: '時刻・行動の矛盾',
};

/** `Scenario.checkResult` に保存するAIチェックの結果。設計書 §9.2 */
export interface ScenarioCheckResult {
  /** running=実行中、done=完了、error=AIの失敗（公開不可。再実行できる） */
  status: 'running' | 'done' | 'error';
  /** チェックした下書きのハッシュ。内容が変わったら無効 */
  hash: string;
  startedAt: number;
  moderation?: {
    /** 1つも該当しなければ true。falseなら公開不可 */
    ok: boolean;
    flags: { category: ModerationCategory; where: string; reason: string }[];
  };
  consistency?: {
    /** 指摘があれば warn。warn でも投稿者が理解した上で公開できる */
    verdict: 'ok' | 'warn';
    findings: { aspect: ConsistencyAspect; message: string }[];
  };
  error?: string;
}
