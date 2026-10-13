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

export interface SeedOptions {
  /**
   * 登録済みの運営シナリオを、そのシナリオの対戦記録ごと削除して作り直す。
   * 公開前の開発環境で、シナリオの本文を直したときだけ使う（本番では使わない）。
   */
  replace?: boolean;
}

/**
 * 運営制作シナリオ（scenarios/*.json）を登録する。
 * 公開済みシナリオの本文は変更できない（仕様書 §6.2）ため、登録済みの slug は何もしない。
 */
export async function seedScenarios(
  db: Db,
  dir: string,
  options: SeedOptions = {},
): Promise<SeedResult> {
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

    const existing = await db.scenario.findUnique({ where: { slug } });
    if (existing && options.replace) {
      // 対戦記録（Game）はシナリオ削除では消えないため、先に削除する
      await db.game.deleteMany({ where: { scenarioId: existing.id } });
      await db.scenario.delete({ where: { id: existing.id } });
    } else if (existing) {
      result.skipped.push(slug);
      continue;
    }
    try {
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
    } catch (e) {
      // 別のプロセスが同時に登録した場合（slug の重複）は、登録済みとして扱う
      if ((e as { code?: string }).code === 'P2002') {
        result.skipped.push(slug);
        continue;
      }
      throw e;
    }
  }
  return result;
}
