/** 設計書 §12。仕様書の【仮】数値の初期値。 */
export const CONFIG = {
  INTRO_MAX_SEC: 60,
  CONFIRM_MAX_SEC: 180,
  REVEAL_SEC: 30,
  TALK_SEC: 600,
  VOTE_SEC: 120,
  /** 結果表示から、ルームを閉じるまでの時間 */
  RESULT_CLOSE_SEC: 1800,
  CHAT_MAX_CHARS: 200,
  CHAT_RATE_PER_SEC: 1,
  IDLE_SWITCH_SEC: 180,
  IDLE_WARN_SEC: 150,
  MATCH_WAIT_SEC: 90,
  REPORT_HIDE_THRESHOLD: 3,
  NPC_TALK_INTERVAL_SEC: [30, 60] as const,
  NPC_MAX_CHARS: 100,
  /** カード公開・投票でNPC席が自動で行動するまでの待ち（AI未使用時の代替。S3でAIの行動に置き換わる） */
  NPC_FALLBACK_DELAY_SEC: 3,
  CHATLOG_RETENTION_DAYS: 90,
} as const;

export type Config = typeof CONFIG;
