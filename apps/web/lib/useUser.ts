'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApiError, api, type UserInfo } from './api';

/** ログイン中のユーザーを取得する。未ログインなら /login へ移動する。 */
export function useRequireUser(): UserInfo | null {
  const router = useRouter();
  const [user, setUser] = useState<UserInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ user: UserInfo }>('/me')
      .then((r) => {
        if (!cancelled) setUser(r.user);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) router.replace('/login');
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return user;
}
