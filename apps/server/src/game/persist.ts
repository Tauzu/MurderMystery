import type { RoomState } from '@mm/game-core';
import type { Db } from '../db';

/** ゲーム開始時に Game と Participation を作る。Game.id をルームIDとして使う。 */
export async function createGameRecords(
  db: Db,
  scenarioId: string,
  scenarioVersion: number,
  state: RoomState,
): Promise<{ gameId: string; participationIds: string[] }> {
  const game = await db.game.create({
    data: {
      scenarioId,
      scenarioVersion,
      participations: {
        create: state.seats.map((s) => ({
          seat: s.index,
          characterId: s.characterId,
          userId: s.userId,
          initialKind: s.npcFromStart ? ('npc' as const) : ('human' as const),
        })),
      },
    },
    include: { participations: true },
  });
  const participationIds: string[] = [];
  for (const p of game.participations) participationIds[p.seat] = p.id;
  return { gameId: game.id, participationIds };
}

/** 確認フェーズに入った時点で、人間のユーザーを「プレイ済み」にする（仕様書 §7.3）。 */
export async function markPlayed(db: Db, scenarioId: string, userIds: string[]) {
  if (userIds.length === 0) return;
  await db.playedScenario.createMany({
    data: userIds.map((userId) => ({ userId, scenarioId })),
    skipDuplicates: true,
  });
}

/**
 * ゲームの結果をまとめてDBに書く（設計書 §6.5）。
 * 結果が出た時点、または中断された時点で一度だけ呼ぶ。
 */
export async function finishGame(
  db: Db,
  gameId: string,
  participationIds: string[],
  state: RoomState,
  now: Date,
) {
  const pid = (seat: number) => participationIds[seat]!;
  const outcomeOf = (seat: number) => {
    const fromResult = state.result?.outcomes.find((o) => o.seat === seat)?.outcome;
    if (fromResult) return fromResult;
    // 中断：結果が無い。最初からNPCだった席は npc、切り替わった席は left
    const s = state.seats[seat]!;
    return s.npcFromStart ? ('npc' as const) : ('left' as const);
  };

  await db.$transaction(async (tx) => {
    await tx.game.update({
      where: { id: gameId },
      data: {
        status: state.aborted ? 'aborted' : 'finished',
        result: state.result ? JSON.parse(JSON.stringify(state.result)) : undefined,
        finishedAt: now,
      },
    });

    for (const s of state.seats) {
      await tx.participation.update({
        where: { id: pid(s.index) },
        data: {
          switchedToNpcAt: s.switchedAt === null ? null : new Date(s.switchedAt),
          outcome: outcomeOf(s.index),
        },
      });
    }

    await tx.chatMessage.createMany({
      data: state.chat.map((m) => ({
        gameId,
        participationId: pid(m.seat),
        setNo: m.setNo,
        body: m.body,
        createdAt: new Date(m.at),
      })),
    });

    await tx.revealedCard.createMany({
      data: state.revealed.map((r) => ({
        gameId,
        participationId: pid(r.seat),
        cardId: r.cardId,
        setNo: r.setNo,
        autoSelected: r.auto,
      })),
    });

    await tx.vote.createMany({
      data: Object.entries(state.votes).map(([voter, target]) => ({
        gameId,
        voterId: pid(Number(voter)),
        targetId: target === null || target === undefined ? null : pid(target),
      })),
    });
  });
}
