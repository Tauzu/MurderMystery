'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, api, type ScenarioSummary } from '../../lib/api';
import { Pending } from '../../components/Pending';
import { useRequireUser } from '../../lib/useUser';

export default function PlayPage() {
  const router = useRouter();
  const { user, error: userError } = useRequireUser();
  const [scenarios, setScenarios] = useState<ScenarioSummary[] | null>(null);
  const [size, setSize] = useState(4);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    api<{ scenarios: ScenarioSummary[] }>('/scenarios/available')
      .then((r) => setScenarios(r.scenarios))
      .catch(() => setError('シナリオを取得できませんでした'));
  }, [user]);

  const start = async (scenarioId: string) => {
    setError(null);
    setBusy(true);
    try {
      await api('/matches', { method: 'POST', body: { scenarioId, size } });
      router.push('/match');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'in_game') router.push('/match');
      else setError(e instanceof ApiError ? e.message : '通信に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  if (!user) return <Pending error={userError} />;

  return (
    <>
      <div className="row spread">
        <h1>ミステリーであそぶ</h1>
        <Link href="/">ホームへ</Link>
      </div>

      <div className="panel">
        <h2>何人で遊びますか？</h2>
        <p className="muted">
          選んだ人数が集まると開始します。足りない席は NPC が担当します（1人なら、すぐ開始します）。
        </p>
        <div className="row">
          {[1, 2, 3, 4].map((n) => (
            <button key={n} className={n === size ? '' : 'secondary'} onClick={() => setSize(n)}>
              {n}人
            </button>
          ))}
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      <h2>未プレイのミステリー</h2>
      {scenarios === null && <p className="muted">読み込み中…</p>}
      {scenarios?.length === 0 && (
        <p className="muted">遊べるミステリーがありません。プレイ済みのものは再挑戦できません。</p>
      )}
      {scenarios?.map((s) => (
        <div key={s.id} className="panel">
          <h3>{s.title}</h3>
          <p>{s.summary}</p>
          <button disabled={busy} onClick={() => start(s.id)}>
            {size}人で遊ぶ
          </button>
        </div>
      ))}
    </>
  );
}
