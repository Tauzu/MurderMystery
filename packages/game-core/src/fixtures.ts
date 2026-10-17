import type { Context, Participant, RoomState, ScenarioData } from './index';
import { createRoom, pickableSeats, reduce } from './index';
import type { RoomEvent } from './types';

/** テスト用の決定的な乱数（mulberry32）。 */
export function seededRng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ['A', 'B', 'C', 'D'];

/**
 * 4キャラ×4枚（目撃証言2枚・証拠品2枚）。文言はキャラごとに一意で、漏洩の検査に使う。
 * C（index 2）が犯人。捏造カードは探偵側 A の4枚目（card-A4）。
 */
export function fixtureScenario(): ScenarioData {
  return {
    introText: 'INTRO-TEXT',
    endingText: 'ENDING-TEXT',
    victim: { name: 'VICTIM-NAME', profile: 'VICTIM-PROFILE' },
    characters: NAMES.map((n, i) => ({
      id: `char-${n}`,
      name: `名前${n}`,
      publicProfile: `PROFILE-${n}`,
      situationText: `SECRET-SITUATION-${n}`,
      isCulprit: i === 2,
      cards: [1, 2, 3, 4].map((k) => ({
        id: `card-${n}${k}`,
        kind: k <= 2 ? ('testimony' as const) : ('item' as const),
        title: `TITLE-${n}${k}`,
        body: `SECRET-CARD-BODY-${n}${k}`,
        isFabricated: n === 'A' && k === 4,
      })),
    })),
  };
}

export const T0 = 1_000_000;

export function ctx(now: number, seed = 1): Context {
  return { now, rng: seededRng(seed) };
}

export const humans = (n: number): Participant[] =>
  Array.from({ length: 4 }, (_, i) =>
    i < n ? { kind: 'human', userId: `user-${i}` } : { kind: 'npc' },
  );

export function newRoom(humanCount = 4, seed = 1): RoomState {
  return createRoom(
    { scenario: fixtureScenario(), participants: humans(humanCount) },
    ctx(T0, seed),
  );
}

/** イベントを適用し、エラーなら例外にする（正常系のテスト用）。 */
export function apply(state: RoomState, event: RoomEvent, now: number) {
  const r = reduce(state, event, ctx(now, 7));
  if (r.error) throw new Error(`${event.type}: ${r.error.code}`);
  return r;
}

export const SEATS = [0, 1, 2, 3];

/** 全席が操作して、次のフェーズまで進める。 */
export function allReady(state: RoomState, now: number) {
  let s = state;
  const phase = s.phase;
  for (const seat of SEATS) {
    if (s.phase !== phase) break; // NPC席がある場合、人間だけで次へ進むことがある
    s = apply(s, { type: 'Ready', seat }, now).state;
  }
  return s;
}

/** seat が、次の席を指名する（その席の手札が尽きていれば、指名できる最初の席）。 */
export function pickNext(state: RoomState, seat: number, now: number) {
  const options = pickableSeats(state, seat);
  const target = options.includes((seat + 1) % 4) ? (seat + 1) % 4 : options[0]!;
  return apply(state, { type: 'PickTarget', seat, target }, now).state;
}

export function allPick(state: RoomState, now: number) {
  let s = state;
  for (const seat of SEATS) s = pickNext(s, seat, now);
  return s;
}

export function allAgreeEnd(state: RoomState, now: number) {
  let s = state;
  const setNo = s.setNo;
  for (const seat of SEATS) {
    if (s.phase !== 'TALK' || s.setNo !== setNo) break;
    s = apply(s, { type: 'AgreeEndTalk', seat }, now).state;
  }
  return s;
}

/** 全席が発言して「操作した」ことにする（TALK 中）。時間を大きく進めるテストで使う。 */
export function chatAll(state: RoomState, now: number) {
  let s = state;
  for (const seat of SEATS) s = apply(s, { type: 'Chat', seat, body: '…' }, now).state;
  return s;
}

/** 投票フェーズまで、全員が操作して進める。 */
export function playToVote(state: RoomState, now = T0 + 1000): RoomState {
  let s = allReady(state, now); // INTRO → CONFIRM
  s = allReady(s, now); // CONFIRM → REVEAL(1)
  for (let set = 1; set <= 3; set++) {
    s = allPick(s, now);
    s = allAgreeEnd(s, now);
  }
  return s;
}

export function culpritSeat(state: RoomState): number {
  return state.seats.find(
    (s) => state.scenario.characters.find((c) => c.id === s.characterId)!.isCulprit,
  )!.index;
}
