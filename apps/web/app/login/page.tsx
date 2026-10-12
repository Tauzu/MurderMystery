'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../../lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [agreeAge, setAgreeAge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') {
        await api('/auth/login', { method: 'POST', body: { email, password } });
      } else {
        await api('/auth/register', {
          method: 'POST',
          body: { email, password, displayName, agreeAge },
        });
      }
      router.replace('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '通信に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>マーダーミステリー・オンライン</h1>
      <form className="panel" onSubmit={submit} style={{ maxWidth: 420 }}>
        <h2>{mode === 'login' ? 'ログイン' : '新規登録'}</h2>
        <label>
          メールアドレス
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </label>
        <label>
          パスワード（8文字以上）
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={mode === 'register' ? 8 : 1}
            required
          />
        </label>
        {mode === 'register' && (
          <>
            <label>
              表示名（20文字まで）
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={20}
                required
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={agreeAge}
                onChange={(e) => setAgreeAge(e.target.checked)}
              />{' '}
              13歳以上です
            </label>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="submit" disabled={busy || (mode === 'register' && !agreeAge)}>
            {mode === 'login' ? 'ログイン' : '登録する'}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError(null);
            }}
          >
            {mode === 'login' ? '新規登録へ' : 'ログインへ'}
          </button>
        </div>
      </form>
    </>
  );
}
