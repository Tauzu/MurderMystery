import { checkScenarioStructure } from '@mm/shared';
import { describe, expect, it } from 'vitest';
import {
  emptyDraft,
  generalIssues,
  issuesByPath,
  normalizeDraft,
  setCulprit,
  setFabricated,
  toPayload,
} from './draft';

describe('draft', () => {
  it('空の下書きは、4人・各4枚(目撃証言2・証拠品2)の形になる', () => {
    const d = emptyDraft();
    expect(d.characters).toHaveLength(4);
    for (const c of d.characters) {
      expect(c.cards.map((x) => x.kind)).toEqual(['testimony', 'testimony', 'item', 'item']);
    }
  });

  it('保存済みの途中の下書きも、編集用の形に整えられる', () => {
    const d = normalizeDraft({ title: 'T', characters: [{ name: 'A', cards: [{ title: 'x' }] }] });
    expect(d.title).toBe('T');
    expect(d.characters).toHaveLength(4);
    expect(d.characters[0]?.name).toBe('A');
    expect(d.characters[0]?.cards).toHaveLength(4);
    expect(d.characters[0]?.cards[0]?.title).toBe('x');
    expect(normalizeDraft(null)).toEqual(emptyDraft());
  });

  it('被害者が空なら項目ごと省き、入力があれば送る', () => {
    expect('victimName' in toPayload(emptyDraft())).toBe(false);
    const d = { ...emptyDraft(), victimName: '鷹森', victimProfile: '船長' };
    expect(toPayload(d)).toMatchObject({ victimName: '鷹森', victimProfile: '船長' });
  });

  it('犯人は1人だけ、捏造カードは1枚だけ指定され、同じカードを選び直すと解除される', () => {
    let d = setCulprit(setCulprit(emptyDraft(), 1), 2);
    expect(d.characters.map((c) => c.isCulprit)).toEqual([false, false, true, false]);

    d = setFabricated(setFabricated(d, 0, 1), 3, 2);
    const flags = d.characters.flatMap((c) => c.cards.map((x) => x.isFabricated));
    expect(flags.filter(Boolean)).toHaveLength(1);
    expect(d.characters[3]?.cards[2]?.isFabricated).toBe(true);

    d = setFabricated(d, 3, 2);
    expect(d.characters.flatMap((c) => c.cards).some((x) => x.isFabricated)).toBe(false);
  });

  it('構造チェックの指摘を、入力欄の位置ごと・全体向けに分けられる', () => {
    const issues = checkScenarioStructure(toPayload(emptyDraft()));
    const byPath = issuesByPath(issues);
    expect(byPath.get('title')).toBe('タイトルは1文字以上で入力してください');
    expect(byPath.get('characters.0.cards.1.body')).toContain('キャラクター1の手札2枚目');
    expect(generalIssues(issues).some((m) => m.includes('犯人'))).toBe(true);
  });
});
