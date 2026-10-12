/**
 * 締め切りまでの残り秒数。
 * サーバーとブラウザの時計がずれていても正しく表示できるよう、
 * 受信時のずれ（offsetMs = サーバー時刻 − ブラウザ時刻）で補正する。
 */
export function secondsLeft(
  deadlineAt: number | null,
  offsetMs: number,
  nowMs: number,
): number | null {
  if (deadlineAt === null) return null;
  return Math.max(0, Math.ceil((deadlineAt - (nowMs + offsetMs)) / 1000));
}

export function formatClock(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 再接続までの待ち時間（1, 2, 4, 8, 最大10秒）。設計書 §7.5。 */
export function backoffMs(attempt: number): number {
  return Math.min(10_000, 1000 * 2 ** attempt);
}

/** 再接続しても無駄な、サーバーからの切断コード（未ログイン・参加者でない・ルームなし）。 */
export function isFatalClose(code: number): boolean {
  return code === 4401 || code === 4403 || code === 4404;
}
