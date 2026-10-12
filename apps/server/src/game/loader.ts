import type { ScenarioData } from '@mm/game-core';
import type { Db } from '../db';

export interface LoadedScenario {
  data: ScenarioData;
  version: number;
}

/** DBのシナリオを、ゲームが使う形に変換する。 */
export async function loadScenarioData(db: Db, scenarioId: string): Promise<LoadedScenario> {
  const s = await db.scenario.findUniqueOrThrow({
    where: { id: scenarioId },
    include: {
      characters: {
        orderBy: { slot: 'asc' },
        include: { cards: { orderBy: { slot: 'asc' } } },
      },
    },
  });
  return {
    version: s.contentVersion,
    data: {
      introText: s.introText,
      endingText: s.endingText,
      characters: s.characters.map((c) => ({
        id: c.id,
        name: c.name,
        publicProfile: c.publicProfile,
        situationText: c.situationText,
        isCulprit: c.isCulprit,
        cards: c.cards.map((card) => ({ id: card.id, title: card.title, body: card.body })),
      })),
    },
  };
}
