'use client';

import { CONFIG } from '@mm/shared';
import { useEffect, useRef } from 'react';
import type { GameSocket } from './useGameSocket';

/** 画面を触っている印になる操作（スクロール、マウス移動、タッチ、キー入力、クリック、開閉など） */
const EVENTS = [
  'pointermove',
  'pointerdown',
  'wheel',
  'scroll',
  'touchstart',
  'keydown',
  'click',
  'toggle',
] as const;

/**
 * 画面操作があったら、一定間隔でサーバーに「操作中」を知らせる（無操作でNPCに切り替わるのを防ぐ。仕様書 §5.4）。
 * 文章を考えている間や、カードを読んでいる間も、画面を触っていれば切り替わらない。
 */
export function useActivityPing(socket: Pick<GameSocket, 'send' | 'spectator'>) {
  const { send, spectator } = socket;
  const lastSentAt = useRef(0);

  useEffect(() => {
    if (spectator) return;
    const onActivity = () => {
      const now = Date.now();
      if (now - lastSentAt.current < CONFIG.ACTIVITY_PING_SEC * 1000) return;
      lastSentAt.current = now;
      send({ type: 'active' });
    };
    // scroll と toggle は要素の中で起きてもよいよう、捕捉段階で受ける
    for (const e of EVENTS)
      window.addEventListener(e, onActivity, { capture: true, passive: true });
    return () => {
      for (const e of EVENTS) window.removeEventListener(e, onActivity, { capture: true });
    };
  }, [send, spectator]);
}
