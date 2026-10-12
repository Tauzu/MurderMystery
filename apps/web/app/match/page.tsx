'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, type MatchStatus } from '../../lib/api';
import { useRequireUser } from '../../lib/useUser';

/** マッチングの待機。数秒おきに状況を確認し、ルームができたら移動する。 */
export default function MatchPage() {
  const router = useRouter();
  const user = useRequireUser();
  const [status, setStatus] = useState<MatchStatus | null>(null);

  useEffect(() => {
    if (!user) return;
    let stopped = false;
    const poll = async () => {
      try {
        const s = await api<MatchStatus>('/matches/current');
        if (stopped) return;
        setStatus(s);
        if (s.status === 'matched') router.replace(`/rooms/${s.roomId}`);
        if (s.status === 'none') router.replace('/play');
      } catch {
        // 一時的な失敗は次の確認で再試行する
      }
    };
    void poll();
    const timer = setInterval(poll, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [user, router]);

  const cancel = async () => {
    await api('/matches/current', { method: 'DELETE' });
    router.replace('/play');
  };

  if (!user || !status) return <p className="muted">読み込み中…</p>;

  return (
    <>
      <h1>マッチング中</h1>
      <div className="panel">
        {status.status === 'waiting' ? (
          <>
            <p>
              参加者を待っています…（{status.waiting} / {status.size} 人）
            </p>
            <p className="muted">
              人数が集まると、自動でゲームが始まります。このページを開いたままお待ちください。
            </p>
            <button className="secondary" onClick={cancel}>
              キャンセル
            </button>
          </>
        ) : (
          <p>ゲームの準備をしています…</p>
        )}
      </div>
    </>
  );
}
