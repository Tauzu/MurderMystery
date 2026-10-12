import { CONFIG, SEAT_COUNT } from '@mm/shared';
import type { Context, RoomState, ScenarioData, Seat } from './types';

export type Participant = { kind: 'human'; userId: string } | { kind: 'npc' };

export interface CreateRoomInput {
  scenario: ScenarioData;
  /** 席数ぶん（4人）。人数が足りない席は NPC を指定する */
  participants: Participant[];
}

/** Fisher-Yates。 */
function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * ルームを作る。キャラクターは席にランダムに割り当てる（仕様書 §4.1）。
 * 犯人役も同様にランダムになる。
 */
export function createRoom(input: CreateRoomInput, ctx: Context): RoomState {
  const { scenario, participants } = input;
  if (participants.length !== SEAT_COUNT) {
    throw new Error(`参加者は ${SEAT_COUNT} 人（NPC含む）で指定してください`);
  }
  if (scenario.characters.length !== SEAT_COUNT) {
    throw new Error(`キャラクターは ${SEAT_COUNT} 人である必要があります`);
  }
  if (scenario.characters.filter((c) => c.isCulprit).length !== 1) {
    throw new Error('犯人は1人だけ指定してください');
  }

  const characters = shuffle(scenario.characters, ctx.rng);
  const seats: Seat[] = participants.map((p, index) => ({
    index,
    characterId: characters[index]!.id,
    kind: p.kind,
    userId: p.kind === 'human' ? p.userId : null,
    npcFromStart: p.kind === 'npc',
    lastActiveAt: ctx.now,
    warned: false,
    switchedAt: null,
  }));

  return {
    phase: 'INTRO',
    setNo: 1,
    deadlineAt: ctx.now + CONFIG.INTRO_MAX_SEC * 1000,
    scenario,
    seats,
    ready: [],
    picks: {},
    revealed: [],
    agreedEnd: [],
    chat: [],
    nextChatId: 1,
    votes: {},
    result: null,
    aborted: false,
  };
}
