import { z } from 'zod';
import { CARDS_PER_CHARACTER, SEAT_COUNT } from './phases';

/** シナリオの入力項目と文字数制限。仕様書 §6.1。 */
export const SCENARIO_LIMITS = {
  title: [1, 40],
  summary: [1, 120],
  introText: [100, 1500],
  endingText: [100, 2000],
  characterName: [1, 20],
  publicProfile: [1, 200],
  situationText: [100, 1000],
  cardTitle: [1, 20],
  cardBody: [1, 300],
} as const;

const text = (range: readonly [number, number]) => z.string().min(range[0]).max(range[1]);

export const cardSchema = z.object({
  title: text(SCENARIO_LIMITS.cardTitle),
  body: text(SCENARIO_LIMITS.cardBody),
});

export const characterSchema = z.object({
  name: text(SCENARIO_LIMITS.characterName),
  publicProfile: text(SCENARIO_LIMITS.publicProfile),
  situationText: text(SCENARIO_LIMITS.situationText),
  isCulprit: z.boolean(),
  cards: z.array(cardSchema).length(CARDS_PER_CHARACTER),
});

export const scenarioContentSchema = z
  .object({
    title: text(SCENARIO_LIMITS.title),
    summary: text(SCENARIO_LIMITS.summary),
    introText: text(SCENARIO_LIMITS.introText),
    endingText: text(SCENARIO_LIMITS.endingText),
    /** 被害者。登場人物欄に表示する。省略可 */
    victimName: text(SCENARIO_LIMITS.characterName).optional(),
    victimProfile: text(SCENARIO_LIMITS.publicProfile).optional(),
    characters: z.array(characterSchema).length(SEAT_COUNT),
  })
  .superRefine((value, ctx) => {
    const culprits = value.characters.filter((c) => c.isCulprit).length;
    if (culprits !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['characters'],
        message: `犯人は1人だけ指定してください（現在 ${culprits} 人）`,
      });
    }
    const names = new Set(value.characters.map((c) => c.name));
    if (names.size !== value.characters.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['characters'],
        message: 'キャラクター名が重複しています',
      });
    }
  });

export type ScenarioContent = z.infer<typeof scenarioContentSchema>;
