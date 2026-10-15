import type { CardKind, Phase } from '@mm/shared';
import { characterOf, partnerOf } from './reduce';
import type { CardData, ChatMessage, GameResult, RoomState, SeatKind } from './types';

/** カードの見える部分。捏造かどうかは含めない */
export interface CardView {
  id: string;
  kind: CardKind;
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
  hands: { seat: number; cards: (CardView & { revealed: boolean; fabricated: boolean })[] }[];
  votes: { seat: number; target: number | null }[];
}

/** 1人のプレイヤーに送ってよい情報だけを集めたもの。 */
export interface RoomView {
  phase: Phase;
  setNo: number;
  deadlineAt: number | null;
  serverNow: number;
  introText: string;
  victim: { name: string; profile: string } | null;
  seats: SeatView[];
  me: {
    seat: number;
    situationText: string;
    /** 自分の手札4枚。公開済みかどうかを付ける */
    cards: (CardView & { revealed: boolean })[];
    /** 犯人かどうかは、自分についてのみ伝える */
    isCulprit: boolean;
    /**
     * どのカードが捏造か。犯人の席にだけ、最初から伝える（他人の手札にあっても）。
     * 犯人以外は null（持ち主にも伝えない）。仕様書 §4.3.1
     */
    fabricatedCard: { seat: number; card: CardView } | null;
  };
  /** INTRO / CONFIRM で「次へ」を押した席 */
  readySeats: number[];
  /** REVEAL で選択済みの席。何を選んだかは同時公開まで伝えない */
  pickedSeats: number[];
  /** 自分が選択中のカード */
  myPick: string | null;
  agreedEndSeats: number[];
  /** いまの会話の相手（NPC）が発言を考え中か */
  partnerTyping: boolean;
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

  const cardView = (c: CardData): CardView => ({
    id: c.id,
    kind: c.kind,
    title: c.title,
    body: c.body,
  });

  let fabricatedCard: RoomView['me']['fabricatedCard'] = null;
  if (me.isCulprit) {
    for (const s of state.seats) {
      const card = characterOf(state, s).cards.find((c) => c.isFabricated);
      if (card) fabricatedCard = { seat: s.index, card: cardView(card) };
    }
  }

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
    victim: state.scenario.victim,
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
      fabricatedCard,
    },
    readySeats: [...state.ready],
    pickedSeats: Object.keys(state.picks).map(Number),
    myPick: state.picks[mySeat.index] ?? null,
    agreedEndSeats: [...state.agreedEnd],
    partnerTyping:
      state.phase === 'TALK' && state.typing.includes(partnerOf(mySeat.index, state.setNo)),
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
                fabricated: c.isFabricated,
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
