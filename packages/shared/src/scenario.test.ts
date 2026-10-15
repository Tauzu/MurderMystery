import { describe, expect, it } from 'vitest';
import { scenarioContentSchema, type ScenarioContent } from './scenario';

const long = (n: number) => 'あ'.repeat(n);

function valid(): ScenarioContent {
  const card = (kind: 'testimony' | 'item', isFabricated = false) => ({
    kind,
    title: 'カード',
    body: '内容',
    isFabricated,
  });
  const character = (name: string, isCulprit: boolean) => ({
    name,
    publicProfile: '設定',
    situationText: long(100),
    isCulprit,
    // 犯人の最後の1枚を捏造カードにする
    cards: [card('testimony'), card('testimony'), card('item'), card('item', isCulprit)],
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

  it('手札の種類が2枚ずつでないと拒否する', () => {
    const s = valid();
    s.characters[1]!.cards[2]!.kind = 'testimony';
    expect(scenarioContentSchema.safeParse(s).success).toBe(false);
  });

  it('捏造カードが0枚だと拒否する', () => {
    const s = valid();
    s.characters[0]!.cards[3]!.isFabricated = false;
    expect(scenarioContentSchema.safeParse(s).success).toBe(false);
  });

  it('捏造カードが2枚だと拒否する', () => {
    const s = valid();
    s.characters[2]!.cards[0]!.isFabricated = true;
    expect(scenarioContentSchema.safeParse(s).success).toBe(false);
  });

  it('捏造カードを探偵側に持たせてもよい', () => {
    const s = valid();
    s.characters[0]!.cards[3]!.isFabricated = false;
    s.characters[2]!.cards[0]!.isFabricated = true;
    expect(scenarioContentSchema.safeParse(s).success).toBe(true);
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
