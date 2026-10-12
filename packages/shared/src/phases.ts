/** 設計書 §6.1。ルームの状態（フェーズ）の並び。 */
export const PHASES = ['WAITING', 'INTRO', 'CONFIRM', 'SET', 'VOTE', 'RESULT', 'CLOSED'] as const;
export type Phase = (typeof PHASES)[number];

/** 1ゲームのセット数（仕様書 §4.2）。 */
export const SET_COUNT = 3;
/** 1ゲームの席数＝キャラクター数。 */
export const SEAT_COUNT = 4;
/** 1キャラクターの手札の枚数。 */
export const CARDS_PER_CHARACTER = 4;
