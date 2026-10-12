'use client';

import { useParams } from 'next/navigation';
import { GameRoom } from '../../../components/GameRoom';
import { Pending } from '../../../components/Pending';
import { useRequireUser } from '../../../lib/useUser';

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const { user, error } = useRequireUser();
  if (!user) return <Pending error={error} />;
  return <GameRoom roomId={roomId} />;
}
