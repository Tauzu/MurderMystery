import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scenarioContentSchema } from '@mm/shared';
import { z } from 'zod';
import type { Db } from './db';

const fileSchema = z.object({ slug: z.string().min(1) }).and(z.looseObject({}));

export interface SeedResult {
  created: string[];
  skipped: string[];
}

/**
 * 運営制作シナリオ（scenarios/*.json）を登録する。
 * 公開済みシナリオの本文は変更できない（仕様書 §6.2）ため、登録済みの slug は何もしない。
 */
export async function seedScenarios(db: Db, dir: string): Promise<SeedResult> {
  const result: SeedResult = { created: [], skipped: [] };
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();

  for (const file of files) {
    const raw: unknown = JSON.parse(await readFile(join(dir, file), 'utf-8'));
    const { slug } = fileSchema.parse(raw);
    const parsed = scenarioContentSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`${file}: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }
    const s = parsed.data;

    if (await db.scenario.findUnique({ where: { slug } })) {
      result.skipped.push(slug);
      continue;
    }
    await db.scenario.create({
      data: {
        slug,
        title: s.title,
        summary: s.summary,
        introText: s.introText,
        endingText: s.endingText,
        status: 'published',
        publishedAt: new Date(),
        characters: {
          create: s.characters.map((c, slot) => ({
            slot,
            name: c.name,
            publicProfile: c.publicProfile,
            situationText: c.situationText,
            isCulprit: c.isCulprit,
            cards: { create: c.cards.map((card, cardSlot) => ({ slot: cardSlot, ...card })) },
          })),
        },
      },
    });
    result.created.push(slug);
  }
  return result;
}
