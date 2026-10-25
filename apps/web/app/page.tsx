'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '../lib/api';
import { Pending } from '../components/Pending';
import { useRequireUser } from '../lib/useUser';

export default function HomePage() {
  const router = useRouter();
  const { user, error } = useRequireUser();

  if (!user) return <Pending error={error} />;

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    router.replace('/login');
  };

  return (
    <>
      <div className="row spread">
        <h1>マーダーミステリー・オンライン</h1>
        <div className="row">
          <span className="muted">{user.displayName} さん</span>
          <button className="secondary" onClick={logout}>
            ログアウト
          </button>
        </div>
      </div>

      <div className="panel">
        <h2>ミステリーであそぶ</h2>
        <p>1〜4人で遊べます。人数が足りない席は、AIのNPCが担当します。</p>
        <Link href="/play">
          <button>あそぶ</button>
        </Link>
      </div>

      <div className="panel">
        <h2>ミステリーを投稿</h2>
        <p>自分で作ったミステリーを公開できます。公開の前に、AIがチェックします。</p>
        <Link href="/author">
          <button>投稿する</button>
        </Link>
      </div>
    </>
  );
}
