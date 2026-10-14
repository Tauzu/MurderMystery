import type { Phase } from '@mm/shared';
import { characterOf, partnerOf } from './reduce';
import type { ChatMessage, GameResult, RoomState, SeatKind } from './types';

export interface CardView {
  id: string;
  title: string;
  body: string;
}

export interface SeatView {
  seat: number;
  characterId: string;
  name: string;
  publicProfile: string;
  kind: SeatKind;
}

export interface RevealedCardView {
  setNo: number;
  seat: number;
  card: CardView;
}

export interface ResultView {
  result: GameResult;
  endingText: string;
  /** 全員の手札の開示（結果画面） */
  hands: { seat: number; cards: (CardView & { revealed: boolean })[] }[];
  votes: { seat: number; target: number | null }[];
}

/** 1人のプレイヤーに送ってよい情報だけを集めたもの。 */
export interface RoomView {
  phase: Phase;
  setNo: number;
  deadlineAt: number | null;
  serverNow: number;
  introText: string;
  seats: SeatView[];
  me: {
    seat: number;
    situationText: string;
    /** 自分の手札4枚。公開済みかどうかを付ける */
    cards: (CardView & { revealed: boolean })[];
    /** 犯人かどうかは、自分についてのみ伝える */
    isCulprit: boolean;
  };
  /** INTRO / CONFIRM で「次へ」を押した席 */
  readySeats: number[];
  /** REVEAL で選択済みの席。何を選んだかは同時公開まで伝えない */
  pickedSeats: number[];
  /** 自分が選択中のカード */
  myPick: string | null;
  agreedEndSeats: number[];
  revealed: RevealedCardView[];
  chat: ChatMessage[];
  /** 投票済みの席。誰に入れたかは結果まで伝えない */
  votedSeats: number[];
  /** RESULT 以降のみ */
  resultView: ResultView | null;
}

/**
 * ルームの状態から、指定した席のプレイヤーが見てよい情報を取り出す。
 * クライアントへ送る唯一の経路にする（設計書 §7.4）。
 * 他の席の状況文・未公開の手札・犯人が誰かは、結果が出るまで含めない。
 */
export function projectView(state: RoomState, seatIndex: number, now: number): RoomView {
  const mySeat = state.seats[seatIndex];
  if (!mySeat) throw new Error(`席が不正です: ${seatIndex}`);
  const me = characterOf(state, mySeat);
  const revealedIds = new Set(state.revealed.map((r) => r.cardId));
  const showResult =
    state.phase === 'RESULT' || (state.phase === 'CLOSED' && state.result !== null);

  const cardView = (c: { id: string; title: string; body: string }): CardView => ({
    id: c.id,
    title: c.title,
    body: c.body,
  });

  const revealed: RevealedCardView[] = state.revealed.map((r) => {
    const seat = state.seats[r.seat]!;
    const card = characterOf(state, seat).cards.find((c) => c.id === r.cardId)!;
    return { setNo: r.setNo, seat: r.seat, card: cardView(card) };
  });

  return {
    phase: state.phase,
    setNo: state.setNo,
    deadlineAt: state.deadlineAt,
    serverNow: now,
    introText: state.scenario.introText,
    seats: state.seats.map((s) => {
      const c = characterOf(state, s);
      return {
        seat: s.index,
        characterId: s.characterId,
        name: c.name,
        publicProfile: c.publicProfile,
        kind: s.kind,
      };
    }),
    me: {
      seat: mySeat.index,
      situationText: me.situationText,
      cards: me.cards.map((c) => ({ ...cardView(c), revealed: revealedIds.has(c.id) })),
      isCulprit: me.isCulprit,
    },
    readySeats: [...state.ready],
    pickedSeats: Object.keys(state.picks).map(Number),
    myPick: state.picks[mySeat.index] ?? null,
    agreedEndSeats: [...state.agreedEnd],
    revealed,
    // プレイ中は自分の組の会話だけ。他の組の会話は結果が出てから開示する
    chat: state.chat
      .filter(
        (m) =>
          showResult ||
          m.scope === 'all' ||
          m.seat === mySeat.index ||
          m.seat === partnerOf(mySeat.index, m.setNo),
      )
      .map((m) => ({ ...m })),
    votedSeats: Object.keys(state.votes).map(Number),
    resultView:
      showResult && state.result
        ? {
            result: state.result,
            endingText: state.scenario.endingText,
            hands: state.seats.map((s) => ({
              seat: s.index,
              cards: characterOf(state, s).cards.map((c) => ({
                ...cardView(c),
                revealed: revealedIds.has(c.id),
              })),
            })),
            votes: state.seats.map((s) => ({
              seat: s.index,
              target: state.votes[s.index] ?? null,
            })),
          }
        : null,
  };
}
