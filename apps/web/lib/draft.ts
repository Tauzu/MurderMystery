import { SEAT_COUNT, type CardKind, type ScenarioIssue } from '@mm/shared';

/** 投稿画面で編集する下書き。入力途中なので、文字列は空でもよい。 */
export interface DraftCard {
  kind: CardKind;
  title: string;
  body: string;
  isFabricated: boolean;
}

export interface DraftCharacter {
  name: string;
  publicProfile: string;
  situationText: string;
  isCulprit: boolean;
  cards: DraftCard[];
}

export interface Draft {
  title: string;
  summary: string;
  introText: string;
  endingText: string;
  victimName: string;
  victimProfile: string;
  characters: DraftCharacter[];
}

/** 手札4枚の並び。目撃証言2枚・証拠品2枚（仕様書 §6.1） */
const CARD_KINDS_IN_ORDER: CardKind[] = ['testimony', 'testimony', 'item', 'item'];

export function emptyDraft(): Draft {
  return {
    title: '',
    summary: '',
    introText: '',
    endingText: '',
    victimName: '',
    victimProfile: '',
    characters: Array.from({ length: SEAT_COUNT }, () => ({
      name: '',
      publicProfile: '',
      situationText: '',
      isCulprit: false,
      cards: CARD_KINDS_IN_ORDER.map((kind) => ({
        kind,
        title: '',
        body: '',
        isFabricated: false,
      })),
    })),
  };
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** サーバーに保存されている下書き（空や途中のもの）を、編集用の形に整える。 */
export function normalizeDraft(raw: unknown): Draft {
  const base = emptyDraft();
  if (typeof raw !== 'object' || raw === null) return base;
  const r = raw as Record<string, unknown>;
  const chars = Array.isArray(r.characters) ? r.characters : [];
  return {
    title: str(r.title),
    summary: str(r.summary),
    introText: str(r.introText),
    endingText: str(r.endingText),
    victimName: str(r.victimName),
    victimProfile: str(r.victimProfile),
    characters: base.characters.map((empty, i) => {
      const c = (chars[i] ?? {}) as Record<string, unknown>;
      const cards = Array.isArray(c.cards) ? c.cards : [];
      return {
        name: str(c.name),
        publicProfile: str(c.publicProfile),
        situationText: str(c.situationText),
        isCulprit: c.isCulprit === true,
        cards: empty.cards.map((e, j) => {
          const card = (cards[j] ?? {}) as Record<string, unknown>;
          return {
            kind: card.kind === 'item' || card.kind === 'testimony' ? card.kind : e.kind,
            title: str(card.title),
            body: str(card.body),
            isFabricated: card.isFabricated === true,
          };
        }),
      };
    }),
  };
}

/**
 * 保存・検証に送る形にする。被害者は任意なので、空なら項目ごと省く
 * （空文字のままだと「1文字以上」の指摘になってしまう）。
 */
export function toPayload(d: Draft): Record<string, unknown> {
  const { victimName, victimProfile, ...rest } = d;
  return {
    ...rest,
    ...(victimName.trim() !== '' || victimProfile.trim() !== ''
      ? { victimName, victimProfile }
      : {}),
  };
}

/** 犯人の指定は1人だけ（ラジオボタンの動き）。 */
export function setCulprit(d: Draft, index: number): Draft {
  return { ...d, characters: d.characters.map((c, i) => ({ ...c, isCulprit: i === index })) };
}

/** 捏造カードの指定は16枚のうち1枚だけ。同じカードをもう一度選ぶと解除する。 */
export function setFabricated(d: Draft, charIndex: number, cardIndex: number): Draft {
  const already = d.characters[charIndex]?.cards[cardIndex]?.isFabricated === true;
  return {
    ...d,
    characters: d.characters.map((c, i) => ({
      ...c,
      cards: c.cards.map((card, j) => ({
        ...card,
        isFabricated: !already && i === charIndex && j === cardIndex,
      })),
    })),
  };
}

const key = (path: readonly (string | number)[]) => path.join('.');

/** 入力欄の位置（'characters.0.name' など）→ 指摘。 */
export function issuesByPath(issues: ScenarioIssue[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const i of issues) {
    const k = key(i.path);
    if (!map.has(k)) map.set(k, i.message);
  }
  return map;
}

/** 入力欄の位置に対応しない指摘（犯人の指定、捏造カードの指定など）。 */
export function generalIssues(issues: ScenarioIssue[]): string[] {
  return issues
    .filter((i) => i.path.length === 0 || i.path.join('.') === 'characters')
    .map((i) => i.message);
}
