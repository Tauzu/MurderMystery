import { describe, expect, it } from 'vitest';
import {
  SEATS,
  T0,
  allAgreeEnd,
  allPick,
  allReady,
  apply,
  culpritSeat,
  newRoom,
  pickNext,
} from './fixtures';
import { characterOf, projectView } from './index';
import type { RoomState } from './types';

const letter = (state: RoomState, seat: number) =>
  characterOf(state, state.seats[seat]!).name.replace('名前', '');

/** 見てはいけない文字列が含まれていないことを確認する。 */
function assertNoLeak(state: RoomState, viewer: number, label: string) {
  const json = JSON.stringify(projectView(state, viewer, T0));
  const showResult = state.phase === 'RESULT' || (state.phase === 'CLOSED' && state.result);
  const revealedIds = new Set(state.revealed.map((r) => r.cardId));
  const viewerIsCulprit = characterOf(state, state.seats[viewer]!).isCulprit;

  for (const seat of SEATS) {
    if (seat === viewer) continue;
    const other = letter(state, seat);
    const ch = characterOf(state, state.seats[seat]!);
    // 他の席の状況文
    expect(json, `${label}: 席${viewer}に席${seat}の状況文が漏れている`).not.toContain(
      `SECRET-SITUATION-${other}`,
    );
    for (const card of ch.cards) {
      if (revealedIds.has(card.id) || showResult) continue;
      // 捏造カードは、犯人には最初から見える（仕様書 §4.3.1）
      if (card.isFabricated && viewerIsCulprit) continue;
      // 他の席の未公開の手札
      expect(json, `${label}: 席${viewer}に席${seat}の未公開カードが漏れている`).not.toContain(
        card.body,
      );
      expect(json, `${label}: 席${viewer}に席${seat}の未公開カードIDが漏れている`).not.toContain(
        card.id,
      );
    }
  }
  if (!showResult) {
    // どのカードが捏造かは、犯人にしか伝えない
    if (!viewerIsCulprit) {
      expect(projectView(state, viewer, T0).me.fabricatedCard, `${label}: 席${viewer}`).toBeNull();
    }
    expect(json).not.toContain('"fabricated"');
    expect(json).not.toContain('isFabricated');
    expect(json).not.toContain('ENDING-TEXT');
    expect(projectView(state, viewer, T0).resultView).toBeNull();
  }
}

describe('projectView（秘匿の保証）', () => {
  it('ゲームの全段階・全席で、他の席の秘密が含まれない', () => {
    let s = newRoom();
    const checkAll = (label: string) => {
      for (const seat of SEATS) assertNoLeak(s, seat, `${label} (${s.phase}/${s.setNo})`);
    };

    checkAll('開始');
    s = allReady(s, T0 + 1);
    checkAll('確認');
    s = allReady(s, T0 + 2);

    for (let set = 1; set <= 3; set++) {
      checkAll(`セット${set}の公開前`);
      // 一人ずつ選び、選択の途中でも他人の選択内容が見えないこと
      for (const seat of SEATS) {
        s = pickNext(s, seat, T0 + 3);
        if (s.phase === 'REVEAL') checkAll(`セット${set}の選択途中`);
      }
      checkAll(`セット${set}の会話`);
      s = apply(s, { type: 'Chat', seat: 0, body: 'こんにちは' }, T0 + 4).state;
      s = allAgreeEnd(s, T0 + 5);
    }

    expect(s.phase).toBe('VOTE');
    checkAll('投票');
    const c = culpritSeat(s);
    for (const seat of SEATS) {
      s = apply(s, { type: 'Vote', seat, target: seat === c ? (c + 1) % 4 : c }, T0 + 6).state;
      if (s.phase === 'VOTE') checkAll('投票途中');
    }
    expect(s.phase).toBe('RESULT');
  });

  it('公開されたカードは全員に見える', () => {
    let s = allReady(allReady(newRoom(), T0), T0);
    s = allPick(s, T0 + 1);
    for (const viewer of SEATS) {
      const v = projectView(s, viewer, T0);
      expect(v.revealed).toHaveLength(4);
      const json = JSON.stringify(v);
      for (const r of s.revealed) {
        expect(json).toContain(v.revealed.find((x) => x.card.id === r.cardId)!.card.body);
      }
      // 誰が誰を指名したかも見える
      expect(v.revealed.map((r) => [r.by, r.seat])).toEqual(s.revealed.map((r) => [r.by, r.seat]));
    }
  });

  it('「入力中」は、いまの会話の相手のNPCについてだけ見える', () => {
    let s = allReady(allReady(newRoom(), T0), T0);
    s = allPick(s, T0 + 1);
    // 席1と席2をNPCにして、席1が入力中（セット1の組は 0-1・2-3）
    s.seats[1]!.kind = 'npc';
    s.seats[2]!.kind = 'npc';
    s = apply(s, { type: 'NpcTyping', seat: 1, typing: true }, T0 + 2).state;
    expect(projectView(s, 0, T0).partnerTyping).toBe(true);
    expect(projectView(s, 2, T0).partnerTyping).toBe(false);
    expect(projectView(s, 3, T0).partnerTyping).toBe(false);
  });

  it('被害者は全員に見える', () => {
    const s = newRoom();
    for (const seat of SEATS) {
      expect(projectView(s, seat, T0).victim).toEqual({
        name: 'VICTIM-NAME',
        profile: 'VICTIM-PROFILE',
      });
    }
  });

  it('自分のキャラの情報は見られる', () => {
    const s = newRoom();
    for (const seat of SEATS) {
      const v = projectView(s, seat, T0);
      const ch = characterOf(s, s.seats[seat]!);
      expect(v.me.situationText).toBe(ch.situationText);
      // 自分の手札は画面に出さない（内容は状況文に含まれる）
      expect('cards' in v.me).toBe(false);
      expect(v.introText).toBe('INTRO-TEXT');
    }
  });

  it('犯人かどうかは、自分についてのみ分かる。席の一覧からは分からない', () => {
    const s = newRoom();
    const c = culpritSeat(s);
    for (const seat of SEATS) {
      const v = projectView(s, seat, T0);
      expect(v.me.isCulprit).toBe(seat === c);
      expect(Object.keys(v.seats[0]!).sort()).toEqual(
        ['characterId', 'kind', 'name', 'publicProfile', 'seat'].sort(),
      );
    }
  });

  it('捏造カードは、探偵側の手札にあっても犯人にだけ最初から分かる。持ち主には分からない', () => {
    const s = newRoom();
    const c = culpritSeat(s);
    const holder = s.seats.find((seat) => seat.characterId === 'char-A')!.index;
    for (const seat of SEATS) {
      const v = projectView(s, seat, T0);
      if (seat === c) {
        expect(v.me.fabricatedCard).toEqual({
          seat: holder,
          card: { id: 'card-A4', kind: 'item', title: 'TITLE-A4', body: 'SECRET-CARD-BODY-A4' },
        });
      } else {
        expect(v.me.fabricatedCard).toBeNull();
      }
    }
    // 持ち主のビューには、手札も捏造の印も含まれない
    expect(JSON.stringify(projectView(s, holder, T0))).not.toContain('SECRET-CARD-BODY-A4');
  });

  it('捏造カードが犯人の手札にある場合も、犯人にだけ分かる', () => {
    const s = newRoom();
    for (const ch of s.scenario.characters) {
      for (const card of ch.cards) card.isFabricated = ch.isCulprit && card.id.endsWith('1');
    }
    const c = culpritSeat(s);
    for (const seat of SEATS) {
      const v = projectView(s, seat, T0);
      expect(v.me.fabricatedCard?.card.id ?? null).toBe(seat === c ? 'card-C1' : null);
      if (seat === c) expect(v.me.fabricatedCard?.seat).toBe(c);
    }
  });

  it('自分が指名した席だけが myPick で分かる。指名できる席も分かる', () => {
    let s = allReady(allReady(newRoom(), T0), T0);
    expect(projectView(s, 0, T0).pickableSeats).toEqual([1, 2, 3]);
    s = apply(s, { type: 'PickTarget', seat: 0, target: 2 }, T0 + 1).state;
    expect(projectView(s, 0, T0).myPick).toBe(2);
    expect(projectView(s, 1, T0).myPick).toBeNull();
    expect(projectView(s, 1, T0).pickedSeats).toEqual([0]);
  });

  it('結果が出ると、結末文・犯人・全員の手札・投票が見られる', () => {
    let s = allReady(allReady(newRoom(), T0), T0);
    for (let set = 1; set <= 3; set++) {
      s = allPick(s, T0 + 1);
      s = allAgreeEnd(s, T0 + 2);
    }
    const c = culpritSeat(s);
    for (const seat of SEATS) {
      s = apply(s, { type: 'Vote', seat, target: seat === c ? (c + 1) % 4 : c }, T0 + 3).state;
    }
    const v = projectView(s, 0, T0);
    expect(v.resultView?.endingText).toBe('ENDING-TEXT');
    expect(v.resultView?.result.culpritSeat).toBe(c);
    expect(v.resultView?.hands).toHaveLength(4);
    expect(v.resultView?.hands.flatMap((h) => h.cards)).toHaveLength(16);
    expect(v.resultView?.votes).toHaveLength(4);
    // 結果では、どれが捏造だったかを全員に開示する
    const fabricated = v.resultView?.hands
      .flatMap((h) => h.cards)
      .filter((card) => card.fabricated);
    expect(fabricated?.map((card) => card.id)).toEqual(['card-A4']);
  });

  it('状態はJSONとして保存・復元でき、復元後も同じように動く', () => {
    const s = allReady(newRoom(), T0);
    const restored = JSON.parse(JSON.stringify(s)) as RoomState;
    expect(restored).toEqual(s);
    expect(allReady(restored, T0 + 1).phase).toBe('REVEAL');
  });
});

describe('projectView（2人1組の会話）', () => {
  /** セット1の会話で、各席が「席N」と発言した状態 */
  function talkingRoom() {
    let s = allReady(allReady(newRoom(), T0), T0);
    s = allPick(s, T0 + 1);
    for (const seat of SEATS) s = apply(s, { type: 'Chat', seat, body: `席${seat}` }, T0 + 2).state;
    return s;
  }

  it('会話中は、自分と組の相手の発言だけが見える（セット1は 0-1・2-3）', () => {
    const s = talkingRoom();
    const bodies = (seat: number) => projectView(s, seat, T0).chat.map((m) => m.body);
    expect(bodies(0)).toEqual(['席0', '席1']);
    expect(bodies(1)).toEqual(['席0', '席1']);
    expect(bodies(2)).toEqual(['席2', '席3']);
    expect(bodies(3)).toEqual(['席2', '席3']);
  });

  it('組が変わっても、過去のセットの会話は自分が参加した分だけ見える', () => {
    let s = allAgreeEnd(talkingRoom(), T0 + 3);
    s = allPick(s, T0 + 4);
    expect(s.setNo).toBe(2);
    for (const seat of SEATS)
      s = apply(s, { type: 'Chat', seat, body: `第2回の席${seat}` }, T0 + 5).state;
    // 席0 は、第1回は席1、第2回は席2と話した
    expect(projectView(s, 0, T0).chat.map((m) => m.body)).toEqual([
      '席0',
      '席1',
      '第2回の席0',
      '第2回の席2',
    ]);
  });

  it('結果が出ると、他の組の会話も含めて全部見える', () => {
    let s = talkingRoom();
    s = allAgreeEnd(s, T0 + 3);
    for (let set = 2; set <= 3; set++) {
      s = allPick(s, T0 + 4);
      s = allAgreeEnd(s, T0 + 5);
    }
    const c = culpritSeat(s);
    for (const seat of SEATS) {
      s = apply(s, { type: 'Vote', seat, target: seat === c ? (c + 1) % 4 : c }, T0 + 6).state;
    }
    expect(s.phase).toBe('RESULT');
    s = apply(s, { type: 'Chat', seat: 3, body: '感想戦' }, T0 + 7).state;
    const chat = projectView(s, 0, T0).chat;
    expect(chat.map((m) => m.body)).toContain('席2');
    expect(chat.at(-1)).toMatchObject({ body: '感想戦', scope: 'all' });
  });
});
