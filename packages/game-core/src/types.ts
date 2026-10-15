import type { CardKind, Phase } from '@mm/shared';

/** ゲームに必要なシナリオの内容。DBの行をこの形に変換してルームに渡す。 */
export interface ScenarioData {
  introText: string;
  endingText: string;
  /** 被害者（任意）。登場人物欄とNPCのプロンプトに出す */
  victim: { name: string; profile: string } | null;
  characters: CharacterData[];
}

export interface CharacterData {
  id: string;
  name: string;
  publicProfile: string;
  situationText: string;
  isCulprit: boolean;
  cards: CardData[];
}

export interface CardData {
  id: string;
  kind: CardKind;
  title: string;
  body: string;
  /** 捏造カード。シナリオ全体で1枚。犯人以外には結果まで伝えない（仕様書 §4.3.1） */
  isFabricated: boolean;
}

export type SeatKind = 'human' | 'npc';

export interface Seat {
  index: number;
  characterId: string;
  kind: SeatKind;
  /** 人間の席のユーザーID。NPCに切り替わった席でも、元のユーザーを残す */
  userId: string | null;
  /** 開始時から NPC だった席か */
  npcFromStart: boolean;
  lastActiveAt: number;
  warned: boolean;
  switchedAt: number | null;
}

export interface RevealedCard {
  setNo: number;
  seat: number;
  cardId: string;
  /** 時間切れで自動的に選ばれたか */
  auto: boolean;
}

export interface ChatMessage {
  id: number;
  seat: number;
  setNo: number;
  /** pair＝TALK中の2人1組の会話（組の2人にだけ見える）、all＝結果後の感想戦（全員に見える） */
  scope: 'pair' | 'all';
  body: string;
  at: number;
}

export type Winner = 'detectives' | 'culprit';
export type SeatOutcome = 'win' | 'lose' | 'left' | 'npc';

export interface GameResult {
  /** 席ごとの得票数 */
  tally: number[];
  /** 最多得票の席（同数なら複数。誰も得票していなければ空） */
  topSeats: number[];
  culpritSeat: number;
  winner: Winner;
  outcomes: { seat: number; outcome: SeatOutcome }[];
}

/** JSON として保存できる、ルームの全状態。 */
export interface RoomState {
  phase: Phase;
  /** 1〜3。REVEAL / TALK で意味を持つ */
  setNo: number;
  /** 現在のフェーズの締め切り（ミリ秒）。無ければ null */
  deadlineAt: number | null;
  scenario: ScenarioData;
  seats: Seat[];
  /** INTRO / CONFIRM で「次へ」を押した席 */
  ready: number[];
  /** REVEAL で選択済みのカード（席 → カードID）。同時公開まで他者には見せない */
  picks: Record<number, string>;
  revealed: RevealedCard[];
  /** TALK で「話し終えた」に同意した席 */
  agreedEnd: number[];
  chat: ChatMessage[];
  nextChatId: number;
  /** VOTE の投票（席 → 対象の席。棄権は null） */
  votes: Record<number, number | null>;
  result: GameResult | null;
  aborted: boolean;
}

export type RoomEvent =
  | { type: 'Ready'; seat: number }
  | { type: 'PickCard'; seat: number; cardId: string }
  | { type: 'Chat'; seat: number; body: string }
  | { type: 'AgreeEndTalk'; seat: number }
  | { type: 'Vote'; seat: number; target: number }
  | { type: 'SwitchToNpc'; seat: number }
  | { type: 'Close' }
  | { type: 'Tick' };

export type Effect =
  /** 確認フェーズに入った。人間のユーザーを「プレイ済み」にする（仕様書 §7.3） */
  | { type: 'MarkPlayed'; userIds: string[] }
  /** 無操作の警告。switchInSec 秒後に NPC へ切り替わる */
  | { type: 'Warn'; seat: number; switchInSec: number }
  | { type: 'SwitchedToNpc'; seat: number; userId: string | null }
  | { type: 'Finished'; result: GameResult }
  /** 人間が全員いなくなり、ゲームを中断した */
  | { type: 'Aborted' };

export interface RoomError {
  code:
    | 'wrong_phase'
    | 'invalid_seat'
    | 'invalid_card'
    | 'already_done'
    | 'invalid_target'
    | 'invalid_body';
  message: string;
}

export interface ReduceResult {
  state: RoomState;
  effects: Effect[];
  /** 不正な操作のとき。state は変化しない */
  error?: RoomError;
}

export interface Context {
  /** 現在時刻（ミリ秒）。テストで自由に進められるよう外から渡す */
  now: number;
  /** 0以上1未満の乱数 */
  rng: () => number;
  /** 無操作で NPC に切り替えるまでの秒数。省略時は CONFIG の値（テストプレイで延ばすために上書きできる） */
  idleSwitchSec?: number;
  /** 切替の警告を出すまでの秒数。省略時は CONFIG の値 */
  idleWarnSec?: number;
}
