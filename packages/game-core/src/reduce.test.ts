import { CONFIG } from '@mm/shared';
import { describe, expect, it } from 'vitest';
import {
  SEATS,
  T0,
  allAgreeEnd,
  chatAll,
  allPick,
  allReady,
  apply,
  ctx,
  culpritSeat,
  fixtureScenario,
  humans,
  newRoom,
  playToVote,
} from './fixtures';
import { createRoom, partnerOf, reduce } from './index';
import type { RoomEvent, RoomState } from './types';

const sec = (s: number) => s * 1000;

function vote(state: RoomState, votes: Record<number, number>, now = T0 + 5000) {
  let s = state;
  for (const [seat, target] of Object.entries(votes)) {
    s = apply(s, { type: 'Vote', seat: Number(seat), target }, now).state;
  }
  return s;
}

describe('createRoom', () => {
  it('INTRO から始まり、4つの席に別々のキャラクターが割り当てられる', () => {
    const s = newRoom();
    expect(s.phase).toBe('INTRO');
    expect(new Set(s.seats.map((x) => x.characterId)).size).toBe(4);
    expect(s.deadlineAt).toBe(T0 + sec(CONFIG.INTRO_MAX_SEC));
  });

  it('割り当ては乱数で変わり、同じ乱数なら同じになる', () => {
    const order = (seed: number) =>
      newRoom(4, seed)
        .seats.map((x) => x.characterId)
        .join();
    expect(order(1)).toBe(order(1));
    const orders = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(order));
    expect(orders.size).toBeGreaterThan(1);
  });

  it('参加者が4人でない、犯人が1人でない場合は作れない', () => {
    expect(() =>
      createRoom({ scenario: fixtureScenario(), participants: humans(4).slice(0, 3) }, ctx(T0)),
    ).toThrow();
    const noCulprit = fixtureScenario();
    noCulprit.characters.forEach((c) => (c.isCulprit = false));
    expect(() => createRoom({ scenario: noCulprit, participants: humans(4) }, ctx(T0))).toThrow();
  });
});

describe('通しの進行（全員が人間）', () => {
  it('全員が揃うまで進まず、揃うと次のフェーズへ進む', () => {
    let s = newRoom();
    s = apply(s, { type: 'Ready', seat: 0 }, T0 + 1).state;
    expect(s.phase).toBe('INTRO');
    s = allReady(s, T0 + 1);
    expect(s.phase).toBe('CONFIRM');
    s = allReady(s, T0 + 2);
    expect(s.phase).toBe('REVEAL');
    expect(s.setNo).toBe(1);
  });

  it('確認フェーズに入った時点で MarkPlayed が出る', () => {
    let s = newRoom();
    let effects: unknown[] = [];
    for (const seat of SEATS) {
      const r = apply(s, { type: 'Ready', seat }, T0 + 1);
      s = r.state;
      effects = effects.concat(r.effects);
    }
    expect(s.phase).toBe('CONFIRM');
    expect(effects).toEqual([
      { type: 'MarkPlayed', userIds: ['user-0', 'user-1', 'user-2', 'user-3'] },
    ]);
  });

  it('各セットで4枚が同時に公開され、3セットで12枚、各人1枚が残る', () => {
    let s = allReady(allReady(newRoom(), T0 + 1), T0 + 1);
    expect(s.phase).toBe('REVEAL');

    for (let set = 1; set <= 3; set++) {
      expect(s.setNo).toBe(set);
      // 3人が選んでも、まだ公開されない
      for (const seat of [0, 1, 2]) {
        const ch = s.seats[seat]!.characterId;
        const card = s.scenario.characters
          .find((c) => c.id === ch)!
          .cards.find((c) => !s.revealed.some((r) => r.cardId === c.id))!;
        s = apply(s, { type: 'PickCard', seat, cardId: card.id }, T0 + 10).state;
      }
      expect(s.phase).toBe('REVEAL');
      expect(s.revealed).toHaveLength((set - 1) * 4);
      // 最後の1人が選ぶと同時に公開される
      const last = s.seats[3]!;
      const card = s.scenario.characters
        .find((c) => c.id === last.characterId)!
        .cards.find((c) => !s.revealed.some((r) => r.cardId === c.id))!;
      s = apply(s, { type: 'PickCard', seat: 3, cardId: card.id }, T0 + 10).state;
      expect(s.phase).toBe('TALK');
      expect(s.revealed).toHaveLength(set * 4);

      s = allAgreeEnd(s, T0 + 20);
    }

    expect(s.phase).toBe('VOTE');
    expect(new Set(s.revealed.map((r) => r.cardId)).size).toBe(12);
    for (const seat of SEATS) {
      expect(s.revealed.filter((r) => r.seat === seat)).toHaveLength(3);
    }
  });

  it('発言は TALK 中のみ。前後の空白は除かれ、記録される', () => {
    let s = allReady(allReady(newRoom(), T0), T0);
    expect(reduce(s, { type: 'Chat', seat: 0, body: 'こんにちは' }, ctx(T0)).error?.code).toBe(
      'wrong_phase',
    );
    s = allPick(s, T0 + 1);
    s = apply(s, { type: 'Chat', seat: 1, body: '  私は何も知りません  ' }, T0 + 2).state;
    expect(s.chat).toEqual([
      { id: 1, seat: 1, setNo: 1, scope: 'pair', body: '私は何も知りません', at: T0 + 2 },
    ]);
  });

  it('結果が出た後は、全員に向けた感想戦の発言ができる', () => {
    const base = playToVote(newRoom());
    const c = culpritSeat(base);
    let s = base;
    for (const seat of SEATS)
      s = apply(s, { type: 'Vote', seat, target: seat === c ? (c + 1) % 4 : c }, T0 + 2000).state;
    expect(s.phase).toBe('RESULT');
    s = apply(s, { type: 'Chat', seat: 2, body: 'お疲れさまでした' }, T0 + 2001).state;
    expect(s.chat.at(-1)).toMatchObject({ seat: 2, scope: 'all' });
  });

  it('NPCの「入力中」は、発言すると消える。会話以外では受け付けない', () => {
    let s = newRoom(1); // 席0だけが人間
    expect(reduce(s, { type: 'NpcTyping', seat: 1, typing: true }, ctx(T0 + 1)).error?.code).toBe(
      'wrong_phase',
    );
    s = allPick(allReady(allReady(s, T0), T0), T0);
    expect(s.phase).toBe('TALK');
    expect(reduce(s, { type: 'NpcTyping', seat: 0, typing: true }, ctx(T0 + 1)).error?.code).toBe(
      'invalid_seat',
    );
    s = apply(s, { type: 'NpcTyping', seat: 1, typing: true }, T0 + 1).state;
    expect(s.typing).toEqual([1]);
    s = apply(s, { type: 'Chat', seat: 1, body: 'こんにちは' }, T0 + 2).state;
    expect(s.typing).toEqual([]);
  });

  it('投票中の発言は拒否される', () => {
    const s = playToVote(newRoom());
    expect(reduce(s, { type: 'Chat', seat: 0, body: 'x' }, ctx(T0 + 2000)).error?.code).toBe(
      'wrong_phase',
    );
  });

  it('会話の組は、3セットで全員が他の3人と1回ずつ当たる', () => {
    for (const seat of SEATS) {
      const partners = [1, 2, 3].map((set) => partnerOf(seat, set));
      expect([...partners].sort()).toEqual(SEATS.filter((x) => x !== seat));
      for (const set of [1, 2, 3]) expect(partnerOf(partnerOf(seat, set), set)).toBe(seat);
    }
  });

  it('全員が犯人に投票すると探偵側の勝ち', () => {
    const base = playToVote(newRoom());
    expect(base.phase).toBe('VOTE');
    const c = culpritSeat(base);
    const votes: Record<number, number> = {};
    for (const seat of SEATS) votes[seat] = seat === c ? (c + 1) % 4 : c;

    const s = vote(base, votes);
    expect(s.phase).toBe('RESULT');
    expect(s.result?.winner).toBe('detectives');
    expect(s.result?.culpritSeat).toBe(c);
    expect(s.result?.outcomes.filter((o) => o.outcome === 'win')).toHaveLength(3);
    expect(s.result?.outcomes.find((o) => o.seat === c)?.outcome).toBe('lose');
  });

  it('犯人以外が最多得票なら犯人の勝ち', () => {
    const base = playToVote(newRoom());
    const c = culpritSeat(base);
    const innocent = (c + 1) % 4;
    const votes: Record<number, number> = {};
    for (const seat of SEATS) votes[seat] = seat === innocent ? c : innocent;

    const s = vote(base, votes);
    expect(s.result?.winner).toBe('culprit');
    expect(s.result?.outcomes.find((o) => o.seat === c)?.outcome).toBe('win');
    expect(s.result?.outcomes.filter((o) => o.outcome === 'lose')).toHaveLength(3);
  });

  it('同数で並んだ場合は犯人の勝ち（犯人を含む同数でも）', () => {
    const base = playToVote(newRoom());
    const c = culpritSeat(base);
    const others = SEATS.filter((x) => x !== c);
    // 犯人に2票、別の人に2票
    const [a, b, d] = others as [number, number, number];
    const s = vote(base, { [c]: a, [a]: c, [b]: c, [d]: a });
    expect(s.result?.tally[c]).toBe(2);
    expect(s.result?.tally[a]).toBe(2);
    expect(s.result?.topSeats).toHaveLength(2);
    expect(s.result?.winner).toBe('culprit');
  });

  it('結果が出ると Finished が出て、Close で閉じる', () => {
    const base = playToVote(newRoom());
    const c = culpritSeat(base);
    let s = base;
    let finished = 0;
    for (const seat of SEATS) {
      const r = apply(s, { type: 'Vote', seat, target: seat === c ? (c + 1) % 4 : c }, T0 + 9);
      s = r.state;
      finished += r.effects.filter((e) => e.type === 'Finished').length;
    }
    expect(finished).toBe(1);
    expect(apply(s, { type: 'Close' }, T0 + 10).state.phase).toBe('CLOSED');
  });
});

describe('時間切れ', () => {
  it('導入は時間切れで確認へ進む', () => {
    const s = newRoom();
    const r = reduce(s, { type: 'Tick' }, ctx(T0 + sec(CONFIG.INTRO_MAX_SEC)));
    expect(r.state.phase).toBe('CONFIRM');
    expect(r.effects.map((e) => e.type)).toContain('MarkPlayed');
  });

  it('公開カードを選ばなかった席は、未公開の手札から自動で1枚が公開される', () => {
    let s = allReady(allReady(newRoom(), T0), T0);
    s = apply(s, { type: 'PickCard', seat: 0, cardId: cardOf(s, 0, 0) }, T0 + 1).state;
    const r = reduce(s, { type: 'Tick' }, ctx(T0 + sec(CONFIG.REVEAL_SEC) + 1));
    expect(r.state.phase).toBe('TALK');
    expect(r.state.revealed).toHaveLength(4);
    expect(r.state.revealed.find((x) => x.seat === 0)?.auto).toBe(false);
    expect(r.state.revealed.filter((x) => x.auto)).toHaveLength(3);
  });

  it('自動公開でも、公開済みのカードは選ばれない', () => {
    let s = allReady(allReady(newRoom(), T0), T0);
    let now = T0;
    for (let set = 1; set <= 3; set++) {
      now += sec(CONFIG.REVEAL_SEC) + 1;
      s = reduce(s, { type: 'Tick' }, ctx(now, set)).state; // 全員自動
      s = chatAll(s, now + sec(CONFIG.TALK_SEC) - 1);
      now += sec(CONFIG.TALK_SEC) + 1;
      s = reduce(s, { type: 'Tick' }, ctx(now)).state;
    }
    expect(s.phase).toBe('VOTE');
    expect(new Set(s.revealed.map((r) => r.cardId)).size).toBe(12);
  });

  it('会話は10分で終わる。全員が同意すれば早く終わる', () => {
    let s = allPick(allReady(allReady(newRoom(), T0), T0), T0);
    expect(s.phase).toBe('TALK');
    s = chatAll(s, T0 + sec(CONFIG.TALK_SEC) - 2);
    expect(reduce(s, { type: 'Tick' }, ctx(T0 + sec(CONFIG.TALK_SEC) - 1)).state.phase).toBe(
      'TALK',
    );
    expect(reduce(s, { type: 'Tick' }, ctx(T0 + sec(CONFIG.TALK_SEC))).state.setNo).toBe(2);

    for (const seat of [0, 1, 2]) s = apply(s, { type: 'AgreeEndTalk', seat }, T0 + 1).state;
    expect(s.phase).toBe('TALK');
    expect(apply(s, { type: 'AgreeEndTalk', seat: 3 }, T0 + 1).state.setNo).toBe(2);
  });

  it('誰も投票しなければ犯人の勝ち', () => {
    const base = playToVote(newRoom());
    const r = reduce(base, { type: 'Tick' }, ctx(T0 + 1000 + sec(CONFIG.VOTE_SEC)));
    expect(r.state.phase).toBe('RESULT');
    expect(r.state.result?.topSeats).toEqual([]);
    expect(r.state.result?.winner).toBe('culprit');
  });

  it('結果表示から30分で閉じる', () => {
    const base = playToVote(newRoom());
    const res = reduce(base, { type: 'Tick' }, ctx(T0 + 1000 + sec(CONFIG.VOTE_SEC))).state;
    const now = T0 + 1000 + sec(CONFIG.VOTE_SEC);
    expect(
      reduce(res, { type: 'Tick' }, ctx(now + sec(CONFIG.RESULT_CLOSE_SEC) - 1)).state.phase,
    ).toBe('RESULT');
    expect(reduce(res, { type: 'Tick' }, ctx(now + sec(CONFIG.RESULT_CLOSE_SEC))).state.phase).toBe(
      'CLOSED',
    );
  });
});

function cardOf(state: RoomState, seat: number, k: number): string {
  const ch = state.scenario.characters.find((c) => c.id === state.seats[seat]!.characterId)!;
  return ch.cards[k]!.id;
}

describe('不正な操作', () => {
  const expectRejected = (state: RoomState, event: RoomEvent, code: string) => {
    const r = reduce(state, event, ctx(T0 + 1));
    expect(r.error?.code).toBe(code);
    expect(r.state).toBe(state); // 状態は変わらない
    expect(r.effects).toEqual([]);
  };

  it('フェーズ違いの操作は拒否される', () => {
    const s = newRoom();
    expectRejected(s, { type: 'PickCard', seat: 0, cardId: 'card-A1' }, 'wrong_phase');
    expectRejected(s, { type: 'Chat', seat: 0, body: 'x' }, 'wrong_phase');
    expectRejected(s, { type: 'Vote', seat: 0, target: 1 }, 'wrong_phase');
    expectRejected(s, { type: 'AgreeEndTalk', seat: 0 }, 'wrong_phase');
    expectRejected(s, { type: 'Close' }, 'wrong_phase');
  });

  it('他人のカード、存在しないカード、選択済みの再選択は拒否される', () => {
    const s = allReady(allReady(newRoom(), T0), T0);
    const other = cardOf(s, 1, 0);
    expectRejected(s, { type: 'PickCard', seat: 0, cardId: other }, 'invalid_card');
    expectRejected(s, { type: 'PickCard', seat: 0, cardId: 'nope' }, 'invalid_card');

    const picked = apply(s, { type: 'PickCard', seat: 0, cardId: cardOf(s, 0, 0) }, T0 + 1).state;
    expectRejected(picked, { type: 'PickCard', seat: 0, cardId: cardOf(s, 0, 1) }, 'already_done');
  });

  it('公開済みのカードは、次のセットで選べない', () => {
    let s = allPick(allReady(allReady(newRoom(), T0), T0), T0);
    const firstRevealed = s.revealed.find((r) => r.seat === 0)!.cardId;
    s = allAgreeEnd(s, T0 + 1);
    expect(s.phase).toBe('REVEAL');
    expectRejected(s, { type: 'PickCard', seat: 0, cardId: firstRevealed }, 'invalid_card');
  });

  it('空・長すぎる発言は拒否される', () => {
    const s = allPick(allReady(allReady(newRoom(), T0), T0), T0);
    expectRejected(s, { type: 'Chat', seat: 0, body: '   ' }, 'invalid_body');
    expectRejected(
      s,
      { type: 'Chat', seat: 0, body: 'あ'.repeat(CONFIG.CHAT_MAX_CHARS + 1) },
      'invalid_body',
    );
    const ok = reduce(
      s,
      { type: 'Chat', seat: 0, body: 'あ'.repeat(CONFIG.CHAT_MAX_CHARS) },
      ctx(T0),
    );
    expect(ok.error).toBeUndefined();
  });

  it('自分への投票・存在しない席への投票・二重投票は拒否される', () => {
    const s = playToVote(newRoom());
    expectRejected(s, { type: 'Vote', seat: 0, target: 0 }, 'invalid_target');
    expectRejected(s, { type: 'Vote', seat: 0, target: 9 }, 'invalid_target');
    expectRejected(s, { type: 'Vote', seat: 9, target: 0 }, 'invalid_seat');
    const voted = apply(s, { type: 'Vote', seat: 0, target: 1 }, T0 + 1).state;
    expectRejected(voted, { type: 'Vote', seat: 0, target: 2 }, 'already_done');
  });

  it('終了したルームへの操作は拒否される。Tick は何もしない', () => {
    const base = playToVote(newRoom());
    const res = reduce(base, { type: 'Tick' }, ctx(T0 + 1000 + sec(CONFIG.VOTE_SEC))).state;
    const closed = apply(res, { type: 'Close' }, T0 + 99_999).state;
    expectRejected(closed, { type: 'Ready', seat: 0 }, 'wrong_phase');
    expect(reduce(closed, { type: 'Tick' }, ctx(T0 + 999_999)).state).toBe(closed);
  });
});

describe('NPCの席', () => {
  it('導入・確認・会話の終了は、人間だけが揃えば進む', () => {
    let s = newRoom(1);
    s = apply(s, { type: 'Ready', seat: 0 }, T0 + 1).state;
    expect(s.phase).toBe('CONFIRM');
    s = apply(s, { type: 'Ready', seat: 0 }, T0 + 2).state;
    expect(s.phase).toBe('REVEAL');
  });

  it('公開と投票は全席（NPC含む）が揃うのを待つ。NPCが入力すれば進む', () => {
    let s = newRoom(1);
    s = apply(apply(s, { type: 'Ready', seat: 0 }, T0).state, { type: 'Ready', seat: 0 }, T0).state;
    s = apply(s, { type: 'PickCard', seat: 0, cardId: cardOf(s, 0, 0) }, T0 + 1).state;
    expect(s.phase).toBe('REVEAL'); // NPC が未選択
    for (const seat of [1, 2, 3]) {
      s = apply(s, { type: 'PickCard', seat, cardId: cardOf(s, seat, 0) }, T0 + 2).state;
    }
    expect(s.phase).toBe('TALK');
  });

  it('NPCの席の結果は npc になる', () => {
    let s = playToVote(newRoom(1));
    const c = culpritSeat(s);
    s = vote(s, Object.fromEntries(SEATS.map((x) => [x, x === c ? (c + 1) % 4 : c])));
    expect(s.result?.outcomes.find((o) => o.seat === 0)?.outcome).not.toBe('npc');
    expect(s.result?.outcomes.filter((o) => o.outcome === 'npc')).toHaveLength(3);
  });
});

describe('無操作によるNPCへの切替', () => {
  it('警告は一度だけ出て、切替時間が来るとNPCに切り替わる', () => {
    let s = newRoom();
    // 席0以外は操作を続け、席0は何もしない（TALK フェーズへ進めておく）
    s = allPick(allReady(allReady(s, T0), T0), T0);
    expect(s.phase).toBe('TALK');

    const warnAt = T0 + sec(CONFIG.IDLE_WARN_SEC);
    const keepAlive = (state: RoomState, now: number) => {
      let x = state;
      for (const seat of [1, 2, 3]) x = apply(x, { type: 'Chat', seat, body: 'いるよ' }, now).state;
      return x;
    };

    s = keepAlive(s, warnAt - 1);
    let r = reduce(s, { type: 'Tick' }, ctx(warnAt));
    expect(r.effects).toEqual([
      { type: 'Warn', seat: 0, switchInSec: CONFIG.IDLE_SWITCH_SEC - CONFIG.IDLE_WARN_SEC },
    ]);
    s = r.state;

    r = reduce(s, { type: 'Tick' }, ctx(warnAt + 1000));
    expect(r.effects).toEqual([]); // 警告は繰り返さない

    s = keepAlive(r.state, T0 + sec(CONFIG.IDLE_SWITCH_SEC) - 1);
    r = reduce(s, { type: 'Tick' }, ctx(T0 + sec(CONFIG.IDLE_SWITCH_SEC)));
    expect(r.effects).toEqual([{ type: 'SwitchedToNpc', seat: 0, userId: 'user-0' }]);
    expect(r.state.seats[0]?.kind).toBe('npc');
    expect(r.state.seats[0]?.userId).toBe('user-0'); // 元のユーザーを残す
    expect(r.state.aborted).toBe(false);
  });

  it('切替までの秒数を上書きすると、その分だけ待つ（テストプレイ用）', () => {
    const s = allPick(allReady(allReady(newRoom(), T0), T0), T0);
    const slow = {
      ...ctx(T0 + sec(CONFIG.IDLE_SWITCH_SEC) + 1000),
      idleSwitchSec: 1800,
      idleWarnSec: 1770,
    };
    const r = reduce(s, { type: 'Tick' }, slow);
    expect(r.state.seats[0]?.kind).toBe('human');
    expect(r.effects).toEqual([]);
    const later = reduce(s, { type: 'Tick' }, { ...slow, now: T0 + sec(1800) });
    expect(later.state.seats[0]?.kind).toBe('npc');
  });

  it('操作すると無操作の時間は数え直される', () => {
    let s = allPick(allReady(allReady(newRoom(), T0), T0), T0);
    s = chatAll(s, T0 + sec(CONFIG.IDLE_SWITCH_SEC) - 1000);
    const r = reduce(s, { type: 'Tick' }, ctx(T0 + sec(CONFIG.IDLE_SWITCH_SEC) + 1000));
    expect(r.state.seats[0]?.kind).toBe('human');
    expect(r.effects).toEqual([]);
  });

  it('自分の操作を終えて他の人を待っている間は、無操作として数えない', () => {
    let s = newRoom();
    s = allReady(s, T0); // CONFIRM へ
    s = apply(s, { type: 'Ready', seat: 0 }, T0 + 1).state; // 席0は準備完了で待機
    // 席0以外は何もしない。席0は長く待つが、切り替わらない
    const r = reduce(s, { type: 'Tick' }, ctx(T0 + sec(CONFIG.IDLE_SWITCH_SEC) - 1000));
    expect(r.state.seats[0]?.kind).toBe('human');
    expect(r.effects.filter((e) => e.type === 'Warn' && e.seat === 0)).toEqual([]);
  });

  it('待機が終わって次のフェーズに入っても、すぐには切り替わらない', () => {
    let s = allReady(newRoom(), T0); // CONFIRM（確認の最大時間は180秒）
    s = apply(s, { type: 'Ready', seat: 0 }, T0 + 1).state;
    // 待機中に Tick が来て lastActiveAt が更新されていること
    const waitUntil = T0 + sec(CONFIG.CONFIRM_MAX_SEC) - 1;
    s = reduce(s, { type: 'Tick' }, ctx(waitUntil)).state;
    // 時間切れで REVEAL へ。このとき席0はすぐ切り替わらない
    const r = reduce(s, { type: 'Tick' }, ctx(T0 + sec(CONFIG.CONFIRM_MAX_SEC)));
    expect(r.state.phase).toBe('REVEAL');
    expect(r.state.seats[0]?.kind).toBe('human');
  });

  it('切り替わった席は、結果で left になる', () => {
    let s = playToVote(newRoom());
    s = apply(s, { type: 'SwitchToNpc', seat: 3 }, T0 + 2000).state;
    const c = culpritSeat(s);
    s = vote(s, Object.fromEntries(SEATS.map((x) => [x, x === c ? (c + 1) % 4 : c])), T0 + 2001);
    expect(s.result?.outcomes.find((o) => o.seat === 3)?.outcome).toBe('left');
  });

  it('人間が全員いなくなったら、ゲームは中断される', () => {
    let s = newRoom(2);
    s = apply(s, { type: 'SwitchToNpc', seat: 0 }, T0 + 1).state;
    const r = reduce(s, { type: 'SwitchToNpc', seat: 1 }, ctx(T0 + 2));
    expect(r.state.aborted).toBe(true);
    expect(r.state.phase).toBe('CLOSED');
    expect(r.effects.map((e) => e.type)).toEqual(['SwitchedToNpc', 'Aborted']);
  });

  it('NPCの席や存在しない席は SwitchToNpc できない', () => {
    const s = newRoom(1);
    expect(reduce(s, { type: 'SwitchToNpc', seat: 2 }, ctx(T0)).error?.code).toBe('invalid_seat');
    expect(reduce(s, { type: 'SwitchToNpc', seat: 9 }, ctx(T0)).error?.code).toBe('invalid_seat');
  });

  it('結果表示中は無操作で切り替わらない', () => {
    const base = playToVote(newRoom());
    const res = reduce(base, { type: 'Tick' }, ctx(T0 + 1000 + sec(CONFIG.VOTE_SEC))).state;
    const r = reduce(res, { type: 'Tick' }, ctx(T0 + 1000 + sec(CONFIG.VOTE_SEC) + 600_000));
    expect(r.state.seats.every((x) => x.kind === 'human')).toBe(true);
  });
});
