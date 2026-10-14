import { projectView, type RoomView } from '@mm/game-core';
import { newRoom, T0 } from '@mm/game-core/src/fixtures';
import { describe, expect, it } from 'vitest';
import { Budget } from './budget';
import {
  copiesSecret,
  similarity,
  decidePick,
  decideTalk,
  decideVote,
  FILLER_LINES,
  mostMentionedSeat,
  parseJsonObject,
  type NpcDeps,
} from './decide';
import type { LlmClient, LlmRequest } from './llm';
import { pickPrompt, systemPrompt, talkPrompt, votePrompt } from './prompt';
import { isAddressed, nextTalkDelayMs } from './schedule';

/** 席0〜3にキャラA〜Dを順に割り当てた部屋。犯人は席2（C）。 */
function orderedRoom() {
  const state = newRoom(1);
  state.seats.forEach((s, i) => (s.characterId = `char-${'ABCD'[i]}`));
  return state;
}

/** 席 seat から見える状態。 */
function viewOf(seat: number, chat: { seat: number; body: string }[] = []): RoomView {
  const state = orderedRoom();
  state.phase = 'TALK';
  state.chat = chat.map((c, i) => ({ id: i, setNo: 1, at: T0, scope: 'pair' as const, ...c }));
  return projectView(state, seat, T0);
}

function mockLlm(replies: (string | Error)[]) {
  const calls: LlmRequest[] = [];
  const llm: LlmClient = {
    async complete(req) {
      calls.push(req);
      const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
      if (r instanceof Error) throw r;
      return { text: r, inputTokens: 1000, outputTokens: 50 };
    },
  };
  return { llm, calls };
}

const deps = (llm: LlmClient, budget = new Budget(300_000)): NpcDeps => ({
  llm,
  budget,
  rng: () => 0,
});

describe('プロンプト：知り得る情報だけを含む', () => {
  for (const seat of [0, 1, 2, 3]) {
    it(`席${seat}のプロンプトに他キャラの秘密が含まれない`, () => {
      const view = viewOf(seat);
      const text = [
        systemPrompt(view.me.isCulprit),
        talkPrompt(view),
        pickPrompt(view),
        votePrompt(view),
      ].join('\n');
      ['A', 'B', 'C', 'D'].forEach((n, i) => {
        if (i === seat) {
          expect(text).toContain(`SECRET-SITUATION-${n}`);
        } else {
          expect(text).not.toContain(`SECRET-SITUATION-${n}`);
          expect(text).not.toContain(`SECRET-CARD-BODY-${n}`);
          expect(text).toContain(`PROFILE-${n}`);
        }
      });
    });
  }

  it('犯人にだけ、隠す指示が入る', () => {
    expect(systemPrompt(true)).toContain('犯人であることを隠し通して');
    expect(systemPrompt(false)).not.toContain('隠し通して');
    expect(systemPrompt(false)).toContain('嘘をつかず');
  });

  it('性格を指定すると、システムプロンプトに入る。指定しなければ入らない', () => {
    expect(systemPrompt(false, '慎重な性格')).toContain('あなたの性格：慎重な性格');
    expect(systemPrompt(false)).not.toContain('あなたの性格');
  });

  it('会話の相手の名前が入り、別の組の発言は含まれない', () => {
    const state = orderedRoom();
    state.phase = 'TALK';
    const say = (seat: number, body: string) =>
      state.chat.push({ id: state.chat.length, seat, setNo: 1, scope: 'pair', body, at: T0 });
    say(0, 'AからBへ');
    say(2, 'CからDへ');
    const text = talkPrompt(projectView(state, 1, T0));
    expect(text).toContain('名前Aと2人で会話');
    expect(text).toContain('AからBへ');
    expect(text).not.toContain('CからDへ');
  });

  it('被害者の名前がプロンプトに入る', () => {
    expect(talkPrompt(viewOf(0))).toContain('VICTIM-NAME');
  });

  it('公開済みカードは本文ごと入る', () => {
    const state = orderedRoom();
    state.revealed.push({ setNo: 1, seat: 0, cardId: 'card-A1', auto: false });
    const text = talkPrompt(projectView(state, 1, T0));
    expect(text).toContain('SECRET-CARD-BODY-A1');
  });
});

describe('decideTalk', () => {
  it('正常なJSONの発言を返す', async () => {
    const { llm } = mockLlm(['{"say": "ところで、昨夜はどこにいましたか？"}']);
    const r = await decideTalk(deps(llm), viewOf(0));
    expect(r).toEqual({ say: 'ところで、昨夜はどこにいましたか？', source: 'ai' });
  });

  it('前後に説明文があってもJSONを読み、文字数を超えたら切り詰める', async () => {
    const long = 'あ'.repeat(300);
    const { llm } = mockLlm([`はい。\n{"say": "${long}"}\n以上です`]);
    const r = await decideTalk(deps(llm), viewOf(0));
    expect(r?.say.length).toBe(100);
  });

  it('形式不正は1回だけ再試行し、2回続けば定型文', async () => {
    const { llm, calls } = mockLlm(['よくわかりません', '{"foo": 1}']);
    const r = await decideTalk(deps(llm), viewOf(0));
    expect(calls).toHaveLength(2);
    expect(r?.source).toBe('fallback');
    expect(FILLER_LINES).toContain(r?.say);
  });

  it('1回目が不正でも2回目が正しければ採用する', async () => {
    const { llm } = mockLlm(['??', '{"say": "ええ。"}']);
    expect((await decideTalk(deps(llm), viewOf(0)))?.say).toBe('ええ。');
  });

  it('状況文を丸写しした発言は破棄して再生成する', async () => {
    const view = viewOf(0);
    view.me.situationText = '私は昨夜、書斎で亡くなった主人の遺言書を一人でこっそり探していた。';
    const { llm, calls } = mockLlm([
      JSON.stringify({ say: `実は${view.me.situationText}んです` }),
      '{"say": "別の話です。"}',
    ]);
    const r = await decideTalk(deps(llm), view);
    expect(calls).toHaveLength(2);
    expect(r?.say).toBe('別の話です。');
  });

  it('自分の直近の発言とほぼ同じ内容は破棄して再生成する', async () => {
    const view = viewOf(0, [
      { seat: 0, body: '昨夜は書斎の近くで物音を聞いたのですが、あなたはどこにいましたか？' },
    ]);
    const { llm, calls } = mockLlm([
      '{"say": "昨夜は書斎の近くで物音を聞きました。あなたはどこにいましたか？"}',
      '{"say": "では、デキャンタの件はどう思いますか？"}',
    ]);
    const r = await decideTalk(deps(llm), view);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.user).toContain('ほぼ同じ内容');
    expect(r?.say).toBe('では、デキャンタの件はどう思いますか？');
  });

  it('自分の発言に相手がまだ返していないとき、繰り返さないよう指示する', async () => {
    const { llm, calls } = mockLlm(['{"say": "別の話をします。"}']);
    await decideTalk(deps(llm), viewOf(0, [{ seat: 0, body: '昨夜はどちらに？' }]));
    expect(calls[0]!.user).toContain('まだ返事をしていません');
    const { llm: llm2, calls: calls2 } = mockLlm(['{"say": "はい。"}']);
    await decideTalk(deps(llm2), viewOf(0, [{ seat: 1, body: '部屋にいました' }]));
    expect(calls2[0]!.user).not.toContain('まだ返事をしていません');
  });

  it('API失敗・タイムアウトのときは null（発言しない）', async () => {
    const { llm } = mockLlm([new Error('timeout')]);
    expect(await decideTalk(deps(llm), viewOf(0))).toBeNull();
  });

  it('予算を使い切ったらAIを呼ばず定型文', async () => {
    const budget = new Budget(1000);
    budget.add(1000, 0);
    const { llm, calls } = mockLlm(['{"say": "x"}']);
    const r = await decideTalk(deps(llm, budget), viewOf(0));
    expect(calls).toHaveLength(0);
    expect(r?.source).toBe('fallback');
  });

  it('使ったトークンを予算に加える', async () => {
    const budget = new Budget(300_000);
    const { llm } = mockLlm(['{"say": "ええ。"}']);
    await decideTalk(deps(llm, budget), viewOf(0));
    expect(budget.usedTokens).toBe(1050);
  });
});

describe('decidePick', () => {
  it('未公開カードのIDを返す', async () => {
    const { llm } = mockLlm(['{"cardId": "card-B3"}']);
    expect(await decidePick(deps(llm), viewOf(1))).toEqual({ cardId: 'card-B3', source: 'ai' });
  });

  it('公開済み・存在しないIDならランダム選択に切り替える', async () => {
    const state = orderedRoom();
    state.phase = 'REVEAL';
    state.revealed.push({ setNo: 1, seat: 1, cardId: 'card-B1', auto: false });
    const view = projectView(state, 1, T0);
    for (const bad of ['card-B1', 'card-A1', 'nonsense']) {
      const { llm } = mockLlm([JSON.stringify({ cardId: bad })]);
      const r = await decidePick(deps(llm), view);
      expect(r.source).toBe('fallback');
      expect(['card-B2', 'card-B3', 'card-B4']).toContain(r.cardId);
    }
  });

  it('API失敗でもランダムで選べる', async () => {
    const { llm } = mockLlm([new Error('down')]);
    expect((await decidePick(deps(llm), viewOf(1))).source).toBe('fallback');
  });
});

describe('decideVote', () => {
  it('自分以外の席への投票を返す', async () => {
    const { llm } = mockLlm(['{"target": 2, "reason": "矛盾があった"}']);
    expect(await decideVote(deps(llm), viewOf(0))).toEqual({
      target: 2,
      reason: '矛盾があった',
      source: 'ai',
    });
  });

  it('自分への投票・範囲外はフォールバック（最も名指しされた人）', async () => {
    const chat = [
      { seat: 0, body: '名前Dが怪しい' },
      { seat: 1, body: '名前Dですか' },
      { seat: 0, body: '名前Dはどう思う？' },
    ];
    const view = viewOf(1, chat);
    for (const bad of [1, 9, -1, 'x']) {
      const { llm } = mockLlm([JSON.stringify({ target: bad })]);
      const r = await decideVote(deps(llm), view);
      expect(r.source).toBe('fallback');
      expect(r.target).toBe(3);
    }
  });

  it('mostMentionedSeat は自分自身には投票しない', () => {
    const view = viewOf(0, [{ seat: 1, body: '名前Aが犯人だ' }]);
    for (let i = 0; i < 20; i++) {
      expect(mostMentionedSeat(view, () => i / 20)).not.toBe(0);
    }
  });
});

describe('補助関数', () => {
  it('parseJsonObject', () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject('no json')).toBeNull();
    expect(parseJsonObject('{broken')).toBeNull();
    expect(parseJsonObject('[1,2]')).toBeNull();
  });

  it('copiesSecret：連続20文字の一致で丸写しと判定', () => {
    const secret = 'あいうえおかきくけこさしすせそたちつてとなにぬねの';
    expect(copiesSecret(`私は${secret.slice(3, 25)}です`, secret)).toBe(true);
    expect(copiesSecret('あいうえお、かきくけこ、さしすせそ', secret)).toBe(false);
    expect(copiesSecret('短い', '短い秘密')).toBe(false);
  });

  it('similarity：言い換えは高く、別の話は低い', () => {
    expect(similarity('昨夜はどこにいましたか？', '昨夜はどこにいましたか。')).toBe(1);
    expect(similarity('昨夜はどこにいましたか？', 'デキャンタの蓋が外れていた')).toBeLessThan(0.2);
  });

  it('Budget：80%で slow、100%で exhausted', () => {
    const b = new Budget(1000);
    b.add(700, 0);
    expect([b.slow, b.exhausted]).toEqual([false, false]);
    b.add(100, 0);
    expect([b.slow, b.exhausted]).toEqual([true, false]);
    b.add(200, 0);
    expect(b.exhausted).toBe(true);
  });

  it('名指しされたら発言を前倒しし、自分が答えたら解除される', () => {
    const asked = viewOf(1, [{ seat: 0, body: '名前Bさん、昨夜は？' }]);
    expect(isAddressed(asked)).toBe(true);
    const answered = viewOf(1, [
      { seat: 0, body: '名前Bさん、昨夜は？' },
      { seat: 1, body: '部屋にいました' },
    ]);
    expect(isAddressed(answered)).toBe(false);

    const rng = () => 0.5;
    const normal = nextTalkDelayMs({ view: answered, rng, budgetSlow: false });
    const urgent = nextTalkDelayMs({ view: asked, rng, budgetSlow: false });
    const slow = nextTalkDelayMs({ view: answered, rng, budgetSlow: true });
    expect(normal).toBe(45_000);
    expect(urgent).toBeLessThan(10_000);
    expect(slow).toBe(90_000);
  });
});
