import type { RoomView } from '@mm/game-core';
import { CONFIG } from '@mm/shared';

/** 今回の組の会話で、相手が最後に発言していて、自分がまだ返していないか。設計書 §8.2。 */
export function isAddressed(view: RoomView): boolean {
  const last = view.chat.filter((m) => m.scope === 'pair' && m.setNo === view.setNo).at(-1);
  return last !== undefined && last.seat !== view.me.seat;
}

/**
 * 次の発言までの待ち時間（ミリ秒）。
 * 通常は30〜60秒のランダム。名指しされていれば前倒しし、予算が逼迫していれば延ばす。
 */
export function nextTalkDelayMs(opts: {
  view: RoomView;
  rng: () => number;
  budgetSlow: boolean;
}): number {
  const [min, max] = CONFIG.NPC_TALK_INTERVAL_SEC;
  let sec = isAddressed(opts.view) ? 5 + opts.rng() * 5 : min + opts.rng() * (max - min);
  if (opts.budgetSlow) sec *= 2;
  return Math.round(sec * 1000);
}
