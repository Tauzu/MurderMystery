'use client';

import type { ClientMessage, RoomView, ServerMessage } from '@mm/game-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { backoffMs, isFatalClose } from './time';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface GameSocket {
  connection: ConnectionState;
  /** 切断の理由（再接続しない場合） */
  closeReason: string | null;
  view: RoomView | null;
  spectator: boolean;
  /** 無操作の警告。NPCに切り替わるまでの秒数 */
  warnSec: number | null;
  /** 自分の席がNPCに切り替わった */
  switched: boolean;
  /** 直近のエラー（数秒で消える） */
  error: string | null;
  /** サーバー時刻 − ブラウザ時刻（ミリ秒） */
  offsetMs: number;
  send: (msg: ClientMessage) => void;
}

const FATAL_REASON: Record<number, string> = {
  4401: 'ログインが必要です',
  4403: 'このルームの参加者ではありません',
  4404: 'ルームが見つかりません（すでに終了した可能性があります）',
};

function wsUrl(roomId: string): string {
  const base = process.env.NEXT_PUBLIC_WS_URL ?? `ws://${window.location.hostname}:3001/ws`;
  return `${base}?roomId=${encodeURIComponent(roomId)}`;
}

/** ゲームルームのWebSocket。切れたら自動で再接続し、再接続時は最新の snapshot が届く。 */
export function useGameSocket(roomId: string): GameSocket {
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [closeReason, setCloseReason] = useState<string | null>(null);
  const [view, setView] = useState<RoomView | null>(null);
  const [spectator, setSpectator] = useState(false);
  const [warnSec, setWarnSec] = useState<number | null>(null);
  const [switched, setSwitched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const showError = (message: string) => {
      setError(message);
      if (errorTimer.current) clearTimeout(errorTimer.current);
      errorTimer.current = setTimeout(() => setError(null), 4000);
    };

    const connect = () => {
      const ws = new WebSocket(wsUrl(roomId));
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setConnection('open');
      };

      ws.onmessage = (ev) => {
        const msg = JSON.parse(String(ev.data)) as ServerMessage;
        switch (msg.type) {
          case 'snapshot':
            // 1つの接続の中では順番どおりに届くため、届いた最新のものをそのまま使う
            setView(msg.view);
            setSpectator(msg.spectator);
            setOffsetMs(msg.view.serverNow - Date.now());
            setWarnSec(null);
            break;
          case 'warn':
            setWarnSec(msg.switchInSec);
            break;
          case 'switched':
            setSwitched(true);
            break;
          case 'error':
            showError(msg.message);
            break;
          case 'pong':
            break;
        }
      };

      ws.onclose = (ev) => {
        if (disposed) return;
        if (isFatalClose(ev.code)) {
          setConnection('closed');
          setCloseReason(FATAL_REASON[ev.code] ?? '切断されました');
          return;
        }
        setConnection('reconnecting');
        retryTimer = setTimeout(connect, backoffMs(attempt++));
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (errorTimer.current) clearTimeout(errorTimer.current);
      wsRef.current?.close();
    };
  }, [roomId]);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  return { connection, closeReason, view, spectator, warnSec, switched, error, offsetMs, send };
}
