'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, type MatchStatus } from '../../lib/api';
import { Pending } from '../../components/Pending';
import { useRequireUser } from '../../lib/useUser';

/** マッチングの待機。数秒おきに状況を確認し、ルームができたら移動する。 */
export default function MatchPage() {
  const router = useRouter();
  const { user, error } = useRequireUser();
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

  const startNow = async () => {
    try {
      await api('/matches/current/start', { method: 'POST' });
    } catch {
      // すでに始まっているときなどは、次の状況確認で画面が切り替わる
    }
  };

  if (!user || !status) return <Pending error={error} />;

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
              人数が集まると、自動でゲームが始まります。あと {status.remainingSec}{' '}
              秒たつと、足りない席を NPC で補って始めます。このページを開いたままお待ちください。
            </p>
            <div className="row">
              <button onClick={startNow}>今すぐ NPC で開始</button>
              <button className="secondary" onClick={cancel}>
                キャンセル
              </button>
            </div>
          </>
        ) : (
          <p>ゲームの準備をしています…</p>
        )}
      </div>
    </>
  );
}
