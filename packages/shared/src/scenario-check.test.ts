import { describe, expect, it } from 'vitest';
import { checkScenarioStructure } from './scenario-check';

describe('checkScenarioStructure', () => {
  it('空の下書きでも例外にならず、日本語の指摘を返す', () => {
    const issues = checkScenarioStructure({});
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.map((i) => i.message)).toContain('タイトルを入力してください');
    expect(issues.map((i) => i.message)).toContain('キャラクターは4人入力してください');
  });

  it('文字数と入力欄の位置を示す', () => {
    const issues = checkScenarioStructure({
      title: 'a'.repeat(41),
      characters: [{ name: '', cards: [{ title: '' }] }],
    });
    const msgs = issues.map((i) => i.message);
    expect(msgs).toContain('タイトルは40文字以内で入力してください');
    expect(msgs).toContain('キャラクター1の名前は1文字以上で入力してください');
    expect(msgs).toContain('キャラクター1の手札1枚目のタイトルは1文字以上で入力してください');
    expect(issues.find((i) => i.message.startsWith('タイトル'))?.path).toEqual(['title']);
  });

  it('人数と手札の枚数、犯人・捏造カードの指定を指摘する', () => {
    const msgs = checkScenarioStructure({ characters: [{ cards: [] }] }).map((i) => i.message);
    expect(msgs).toContain('キャラクターは4人入力してください');
    expect(msgs).toContain('キャラクター1の手札は4枚入力してください');
  });
});
