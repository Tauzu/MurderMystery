'use client';

import { useParams } from 'next/navigation';
import { GameRoom } from '../../../components/GameRoom';
import { useRequireUser } from '../../../lib/useUser';

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const user = useRequireUser();
  if (!user) return <p className="muted">読み込み中…</p>;
  return <GameRoom roomId={roomId} />;
}
