'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Pending } from '../../components/Pending';
import { ApiError, api } from '../../lib/api';
import { useRequireUser } from '../../lib/useUser';

interface MyScenario {
  id: string;
  title: string;
  status: 'draft' | 'published' | 'hidden_by_author' | 'hidden_by_report' | 'hidden_by_admin';
  updatedAt: string;
}

const STATUS_LABELS: Record<MyScenario['status'], string> = {
  draft: '下書き',
  published: '公開中',
  hidden_by_author: '非公開（自分で設定）',
  hidden_by_report: '非公開（通報による）',
  hidden_by_admin: '非公開（運営による）',
};

export default function AuthorPage() {
  const router = useRouter();
  const { user, error } = useRequireUser();
  const [scenarios, setScenarios] = useState<MyScenario[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setScenarios((await api<{ scenarios: MyScenario[] }>('/me/scenarios')).scenarios);
    } catch {
      setMessage('一覧を取得できませんでした');
    }
  }, []);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  if (!user) return <Pending error={error} />;

  const act = async (fn: () => Promise<unknown>) => {
    setMessage(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : '通信に失敗しました');
    }
  };

  const create = () =>
    act(async () => {
      const r = await api<{ scenario: { id: string } }>('/scenarios', {
        method: 'POST',
        body: {},
      });
      router.push(`/author/${r.scenario.id}`);
    });

  return (
    <>
      <div className="row spread">
        <h1>投稿したミステリー</h1>
        <Link href="/">ホームへ</Link>
      </div>
      {message && <div className="banner danger">{message}</div>}

      <div className="panel">
        <button onClick={create}>新しく作る</button>
        <p className="muted">
          下書きは何度でも保存できます。公開の前に、AIチェックを受けます。公開した後は、本文を変更できません。
        </p>
      </div>

      {scenarios === null ? (
        <p className="muted">読み込み中…</p>
      ) : scenarios.length === 0 ? (
        <p className="muted">まだ投稿はありません。</p>
      ) : (
        <ul className="plain">
          {scenarios.map((s) => (
            <li key={s.id} className="row spread">
              <div>
                <strong>{s.title}</strong> <span className="badge">{STATUS_LABELS[s.status]}</span>
                <div className="muted">更新 {new Date(s.updatedAt).toLocaleString('ja-JP')}</div>
              </div>
              <div className="row">
                {s.status === 'draft' && (
                  <>
                    <Link href={`/author/${s.id}`}>
                      <button>編集</button>
                    </Link>
                    <button
                      className="secondary"
                      onClick={() => {
                        if (window.confirm('この下書きを削除します。元に戻せません。')) {
                          void act(() => api(`/scenarios/${s.id}`, { method: 'DELETE' }));
                        }
                      }}
                    >
                      削除
                    </button>
                  </>
                )}
                {s.status === 'published' && (
                  <button
                    className="secondary"
                    onClick={() => act(() => api(`/scenarios/${s.id}/hide`, { method: 'POST' }))}
                  >
                    非公開にする
                  </button>
                )}
                {s.status === 'hidden_by_author' && (
                  <button
                    className="secondary"
                    onClick={() => act(() => api(`/scenarios/${s.id}/unhide`, { method: 'POST' }))}
                  >
                    公開に戻す
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
