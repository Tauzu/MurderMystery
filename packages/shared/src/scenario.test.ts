import { describe, expect, it } from 'vitest';
import { scenarioContentSchema, type ScenarioContent } from './scenario';

const long = (n: number) => 'あ'.repeat(n);

function valid(): ScenarioContent {
  const card = { title: 'カード', body: '内容' };
  const character = (name: string, isCulprit: boolean) => ({
    name,
    publicProfile: '設定',
    situationText: long(100),
    isCulprit,
    cards: [card, card, card, card],
  });
  return {
    title: 'タイトル',
    summary: '概要',
    introText: long(100),
    endingText: long(100),
    characters: [
      character('A', true),
      character('B', false),
      character('C', false),
      character('D', false),
    ],
  };
}

describe('scenarioContentSchema', () => {
  it('正しい内容を受け付ける', () => {
    expect(scenarioContentSchema.safeParse(valid()).success).toBe(true);
  });

  it('犯人が0人だと拒否する', () => {
    const s = valid();
    s.characters.forEach((c) => (c.isCulprit = false));
    expect(scenarioContentSchema.safeParse(s).success).toBe(false);
  });

  it('犯人が2人だと拒否する', () => {
    const s = valid();
    s.characters[1]!.isCulprit = true;
    expect(scenarioContentSchema.safeParse(s).success).toBe(false);
  });

  it('キャラクターが4人でないと拒否する', () => {
    const s = valid();
    s.characters.pop();
    expect(scenarioContentSchema.safeParse(s).success).toBe(false);
  });

  it('手札が4枚でないと拒否する', () => {
    const s = valid();
    s.characters[0]!.cards.pop();
    expect(scenarioContentSchema.safeParse(s).success).toBe(false);
  });

  it('キャラクター名の重複を拒否する', () => {
    const s = valid();
    s.characters[1]!.name = 'A';
    expect(scenarioContentSchema.safeParse(s).success).toBe(false);
  });

  it('冒頭文が短すぎると拒否する', () => {
    const s = valid();
    s.introText = long(99);
    expect(scenarioContentSchema.safeParse(s).success).toBe(false);
  });
});
