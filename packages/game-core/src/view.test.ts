import { describe, expect, it } from 'vitest';
import { SEATS, T0, allAgreeEnd, allReady, apply, culpritSeat, newRoom } from './fixtures';
import { characterOf, projectView } from './index';
import type { RoomState } from './types';

const letter = (state: RoomState, seat: number) =>
  characterOf(state, state.seats[seat]!).name.replace('名前', '');

/** 見てはいけない文字列が含まれていないことを確認する。 */
function assertNoLeak(state: RoomState, viewer: number, label: string) {
  const json = JSON.stringify(projectView(state, viewer, T0));
  const showResult = state.phase === 'RESULT' || (state.phase === 'CLOSED' && state.result);
  const revealedIds = new Set(state.revealed.map((r) => r.cardId));

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
        const ch = characterOf(s, s.seats[seat]!);
        const card = ch.cards.find((c) => !s.revealed.some((r) => r.cardId === c.id))!;
        s = apply(s, { type: 'PickCard', seat, cardId: card.id }, T0 + 3).state;
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
    for (const seat of SEATS) {
      const ch = characterOf(s, s.seats[seat]!);
      s = apply(s, { type: 'PickCard', seat, cardId: ch.cards[0]!.id }, T0 + 1).state;
    }
    for (const viewer of SEATS) {
      const v = projectView(s, viewer, T0);
      expect(v.revealed).toHaveLength(4);
      const json = JSON.stringify(v);
      for (const seat of SEATS) {
        const ch = characterOf(s, s.seats[seat]!);
        expect(json).toContain(ch.cards[0]!.body);
      }
    }
  });

  it('自分のキャラの情報は見られる', () => {
    const s = newRoom();
    for (const seat of SEATS) {
      const v = projectView(s, seat, T0);
      const ch = characterOf(s, s.seats[seat]!);
      expect(v.me.situationText).toBe(ch.situationText);
      expect(v.me.cards.map((c) => c.id)).toEqual(ch.cards.map((c) => c.id));
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

  it('自分が選択中のカードだけが myPick で分かる', () => {
    let s = allReady(allReady(newRoom(), T0), T0);
    const card = characterOf(s, s.seats[0]!).cards[1]!;
    s = apply(s, { type: 'PickCard', seat: 0, cardId: card.id }, T0 + 1).state;
    expect(projectView(s, 0, T0).myPick).toBe(card.id);
    expect(projectView(s, 1, T0).myPick).toBeNull();
    expect(projectView(s, 1, T0).pickedSeats).toEqual([0]);
  });

  it('結果が出ると、結末文・犯人・全員の手札・投票が見られる', () => {
    let s = allReady(allReady(newRoom(), T0), T0);
    for (let set = 1; set <= 3; set++) {
      for (const seat of SEATS) {
        const ch = characterOf(s, s.seats[seat]!);
        const card = ch.cards.find((c) => !s.revealed.some((r) => r.cardId === c.id))!;
        s = apply(s, { type: 'PickCard', seat, cardId: card.id }, T0 + 1).state;
      }
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
  });

  it('状態はJSONとして保存・復元でき、復元後も同じように動く', () => {
    const s = allReady(newRoom(), T0);
    const restored = JSON.parse(JSON.stringify(s)) as RoomState;
    expect(restored).toEqual(s);
    expect(allReady(restored, T0 + 1).phase).toBe('REVEAL');
  });
});
