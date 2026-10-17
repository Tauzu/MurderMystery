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
  /** 待機画面からの確認がこの秒数なければ、ブラウザを閉じたとみなして待機列から外す */
  MATCH_STALE_SEC: 15,
  REPORT_HIDE_THRESHOLD: 3,
  NPC_TALK_INTERVAL_SEC: [30, 60] as const,
  NPC_MAX_CHARS: 100,
  /** カード公開・投票でNPC席が自動で行動するまでの待ち（AI未使用時の代替。S3でAIの行動に置き換わる） */
  NPC_FALLBACK_DELAY_SEC: 3,
  /** NPCに使うモデル。品質評価の結果次第で変える（設計書 §8.6） */
  NPC_MODEL: 'claude-haiku-5-5',
  NPC_MAX_OUTPUT_TOKENS: 300,
  /** プロンプトに含める直近の会話件数 */
  NPC_HISTORY_COUNT: 30,
  /** AI呼び出しのタイムアウト */
  NPC_AI_TIMEOUT_SEC: 15,
  /** 1ゲームで使えるAIの総トークン（入力＋出力）。80%で発言間隔を延ばし、100%で定型文のみ【仮】 */
  NPC_BUDGET_TOKENS: 300_000,
  /** 直近にこの秒数以内の発言があれば、NPCの発言をずらす */
  NPC_TALK_COLLISION_SEC: 5,
  /** 発言前に「入力中…」を出す秒数の範囲 */
  NPC_TYPING_SEC: [2, 4] as const,
  /** 自分の発言に相手が返していないとき、続けて話すまで待つ秒数（同じ話の繰り返しを避ける） */
  NPC_FOLLOWUP_WAIT_SEC: 90,
  CHATLOG_RETENTION_DAYS: 90,
} as const;

export type Config = typeof CONFIG;
