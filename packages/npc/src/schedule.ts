import type { RoomView } from '@mm/game-core';
import { CONFIG } from '@mm/shared';

/** 自分のキャラが、最後の自分の発言より後に名指しされているか。設計書 §8.2。 */
export function isAddressed(view: RoomView): boolean {
  const name = view.seats[view.me.seat]!.name;
  let lastOwn = -1;
  view.chat.forEach((m, i) => {
    if (m.seat === view.me.seat) lastOwn = i;
  });
  return view.chat.slice(lastOwn + 1).some((m) => m.seat !== view.me.seat && m.body.includes(name));
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
