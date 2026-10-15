/**
 * ルームの状態（フェーズ）の並び。設計書 §6.1。
 * マッチングはルーム作成の前に行うため、ルームは INTRO から始まる。
 * 各セットは REVEAL → TALK の2状態で表し、セット番号は別に持つ。
 */
export const PHASES = ['INTRO', 'CONFIRM', 'REVEAL', 'TALK', 'VOTE', 'RESULT', 'CLOSED'] as const;
export type Phase = (typeof PHASES)[number];

/** 1ゲームのセット数（仕様書 §4.2）。 */
export const SET_COUNT = 3;
/** 1ゲームの席数＝キャラクター数。 */
export const SEAT_COUNT = 4;
/** 1キャラクターの手札の枚数。 */
export const CARDS_PER_CHARACTER = 4;

/** カードの種類（仕様書 §4.3.1）。目撃証言と証拠品。 */
export const CARD_KINDS = ['testimony', 'item'] as const;
export type CardKind = (typeof CARD_KINDS)[number];
/** 1キャラクターの手札に入る、種類ごとの枚数。 */
export const CARDS_PER_KIND = 2;
/** 表示用の種類名。 */
export const CARD_KIND_LABELS: Record<CardKind, string> = {
  testimony: '目撃証言',
  item: '証拠品',
};
