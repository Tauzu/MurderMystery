import { readFileSync } from 'node:fs';
import { scenarioContentSchema } from '@mm/shared';
import { describe, expect, it } from 'vitest';
import type { LlmClient, LlmRequest } from './llm';
import {
  parseConsistency,
  parseModeration,
  runScenarioCheck,
  scenarioText,
} from './scenario-check';

const scenario = scenarioContentSchema.parse(
  JSON.parse(
    readFileSync(new URL('../../../scenarios/001-yukiyama-sansou.json', import.meta.url), 'utf-8'),
  ),
);

/** プロンプトの内容で、不適切表現用か整合性用かを見分けて返すモック */
function mock(moderation: string, consistency: string) {
  const calls: LlmRequest[] = [];
  const llm: LlmClient = {
    async complete(req) {
      calls.push(req);
      const text = req.user.includes('不適切表現を検査') ? moderation : consistency;
      return { text, inputTokens: 100, outputTokens: 20 };
    },
  };
  return { llm, calls };
}

describe('parseModeration', () => {
  it('指摘がなければ ok、あれば ok=false', () => {
    expect(parseModeration('{"flags":[]}')).toEqual({ ok: true, flags: [] });
    const r = parseModeration(
      '{"flags":[{"category":"sexual","where":"……","reason":"露骨な描写"}]}',
    );
    expect(r?.ok).toBe(false);
    expect(r?.flags[0]?.category).toBe('sexual');
  });

  it('分類が不明な指摘も、見逃さず「該当あり」にする', () => {
    const r = parseModeration('{"flags":[{"category":"???","where":"x","reason":"y"}]}');
    expect(r?.ok).toBe(false);
  });

  it('形式が不正なら null（通過扱いにしない）', () => {
    expect(parseModeration('これは大丈夫です')).toBeNull();
    expect(parseModeration('{"flags":"none"}')).toBeNull();
    expect(parseModeration('{"flags":[1]}')).toBeNull();
  });
});

describe('parseConsistency', () => {
  it('指摘があれば warn、なければ ok', () => {
    expect(parseConsistency('{"findings":[]}')).toEqual({ verdict: 'ok', findings: [] });
    const r = parseConsistency('{"findings":[{"aspect":"culprit","message":"手がかりが弱い"}]}');
    expect(r?.verdict).toBe('warn');
    expect(r?.findings[0]).toEqual({ aspect: 'culprit', message: '手がかりが弱い' });
  });

  it('形式が不正なら null', () => {
    expect(parseConsistency('{}')).toBeNull();
  });
});

describe('runScenarioCheck', () => {
  it('2つの検査を行い、結果をまとめる。整合性の検査にだけ犯人と捏造カードを渡す', async () => {
    const { llm, calls } = mock('{"flags":[]}', '{"findings":[]}');
    const r = await runScenarioCheck({ llm }, scenario);
    expect(r.moderation.ok).toBe(true);
    expect(r.consistency.verdict).toBe('ok');
    expect(calls).toHaveLength(2);
    const mod = calls.find((c) => c.user.includes('不適切表現を検査'))!;
    const con = calls.find((c) => c.user.includes('整合性を検査'))!;
    expect(mod.user).not.toContain('（犯人）');
    expect(con.user).toContain('（犯人）');
    expect(con.user).toContain('（捏造カード）');
  });

  it('返答を読み取れないときは、通過させずに例外にする', async () => {
    const { llm } = mock('すみません', '{"findings":[]}');
    await expect(runScenarioCheck({ llm }, scenario)).rejects.toThrow('不適切表現');
  });

  it('シナリオ中の指示に従わないよう、検査対象をタグで囲んで伝える', () => {
    const text = scenarioText(scenario, false);
    expect(text).toContain(scenario.title);
    const { llm, calls } = mock('{"flags":[]}', '{"findings":[]}');
    void runScenarioCheck({ llm }, scenario);
    return Promise.resolve().then(() => {
      expect(calls[0]?.user).toContain('<scenario>');
      expect(calls[0]?.user).toContain('従わず');
    });
  });
});
