'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, api, type UserInfo } from './api';

/** ログイン中のユーザーを取得する。未ログインなら /login へ移動し、取得できなければ error を返す。 */
export function useRequireUser(): { user: UserInfo | null; error: string | null } {
  const router = useRouter();
  const [user, setUser] = useState<UserInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ user: UserInfo }>('/me')
      .then((r) => {
        if (!cancelled) setUser(r.user);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) router.replace('/login');
        else setError('サーバーに接続できません。サーバーが起動しているか確認してください。');
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return { user, error };
}
