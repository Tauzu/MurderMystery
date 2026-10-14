import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedScenarios } from './seed';
import { cleanupTestUsers, createTestApp, sessionCookie, uniqueEmail } from './test-helpers';

const t = createTestApp();
const scenariosDir = fileURLToPath(new URL('../../../scenarios', import.meta.url));

async function login() {
  const res = await t.app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: {
      email: uniqueEmail(),
      password: 'correct-horse-battery',
      displayName: 'テスター',
      agreeAge: true,
    },
  });
  return { cookies: sessionCookie(res), userId: res.json().user.id as string };
}

beforeAll(async () => {
  await seedScenarios(t.db, scenariosDir);
});

afterAll(async () => {
  await cleanupTestUsers(t.db);
  await t.close();
});

describe('seed', () => {
  it('運営制作シナリオが4キャラ・16枚の手札で登録され、犯人は1人', async () => {
    const s = await t.db.scenario.findUniqueOrThrow({
      where: { slug: '001-yukiyama-sansou' },
      include: { characters: { include: { cards: true } } },
    });
    expect(s.status).toBe('published');
    expect(s.characters).toHaveLength(4);
    expect(s.characters.flatMap((c) => c.cards)).toHaveLength(16);
    expect(s.characters.filter((c) => c.isCulprit)).toHaveLength(1);
  });

  it('2回実行しても重複登録されない', async () => {
    const again = await seedScenarios(t.db, scenariosDir);
    expect(again.created).toEqual([]);
    expect(again.skipped).toContain('001-yukiyama-sansou');
    expect(await t.db.scenario.count({ where: { slug: '001-yukiyama-sansou' } })).toBe(1);
  });

  it('replace を指定すると、登録済みのシナリオを対戦記録ごと作り直す', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mm-seed-'));
    try {
      const file = join(dir, 'test-replace.json');
      await cp(join(scenariosDir, '001-yukiyama-sansou.json'), file);
      const edit = async (title: string) => {
        const json = JSON.parse(await readFile(file, 'utf-8'));
        await writeFile(file, JSON.stringify({ ...json, slug: 'test-replace', title }));
      };

      await edit('最初の版');
      await seedScenarios(t.db, dir);
      await edit('直した版');
      const kept = await seedScenarios(t.db, dir);
      expect(kept.skipped).toContain('test-replace');
      expect(
        (await t.db.scenario.findUniqueOrThrow({ where: { slug: 'test-replace' } })).title,
      ).toBe('最初の版');

      const replaced = await seedScenarios(t.db, dir, { replace: true });
      expect(replaced.created).toContain('test-replace');
      expect(
        (await t.db.scenario.findUniqueOrThrow({ where: { slug: 'test-replace' } })).title,
      ).toBe('直した版');
    } finally {
      await t.db.scenario.deleteMany({ where: { slug: 'test-replace' } });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('犯人を2人にすることはDBの制約でも拒否される', async () => {
    const s = await t.db.scenario.findUniqueOrThrow({
      where: { slug: '001-yukiyama-sansou' },
      include: { characters: true },
    });
    const notCulprit = s.characters.find((c) => !c.isCulprit)!;
    await expect(
      t.db.character.update({ where: { id: notCulprit.id }, data: { isCulprit: true } }),
    ).rejects.toThrow();
  });
});

describe('GET /scenarios/available', () => {
  it('未ログインは401', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/scenarios/available' });
    expect(res.statusCode).toBe(401);
  });

  it('公開済みシナリオが返り、真相に関する項目は含まれない', async () => {
    const { cookies } = await login();
    const res = await t.app.inject({ method: 'GET', url: '/scenarios/available', cookies });
    expect(res.statusCode).toBe(200);
    const list = res.json().scenarios as Record<string, unknown>[];
    const item = list.find((s) => s.title === '雪山荘の晩餐');
    expect(item).toBeDefined();
    expect(Object.keys(item!).sort()).toEqual(['id', 'publishedAt', 'summary', 'title']);
    expect(res.body).not.toContain('葵');
  });

  it('プレイ済みのシナリオは表示されない', async () => {
    const { cookies, userId } = await login();
    const s = await t.db.scenario.findUniqueOrThrow({ where: { slug: '001-yukiyama-sansou' } });
    await t.db.playedScenario.create({ data: { userId, scenarioId: s.id } });

    const res = await t.app.inject({ method: 'GET', url: '/scenarios/available', cookies });
    const ids = (res.json().scenarios as { id: string }[]).map((x) => x.id);
    expect(ids).not.toContain(s.id);
  });

  it('自分が投稿したシナリオは表示されず、他人が投稿したものは表示される', async () => {
    const { cookies, userId } = await login();
    const other = await login();
    const make = (authorId: string, title: string) =>
      t.db.scenario.create({
        data: {
          title,
          summary: 's',
          introText: 'i',
          endingText: 'e',
          authorId,
          status: 'published',
          publishedAt: new Date(),
        },
      });
    const mine = await make(userId, '自作');
    const theirs = await make(other.userId, '他人作');
    try {
      const res = await t.app.inject({ method: 'GET', url: '/scenarios/available', cookies });
      const ids = (res.json().scenarios as { id: string }[]).map((x) => x.id);
      expect(ids).not.toContain(mine.id);
      expect(ids).toContain(theirs.id);
    } finally {
      await t.db.scenario.deleteMany({ where: { id: { in: [mine.id, theirs.id] } } });
    }
  });

  it('非公開のシナリオは表示されない', async () => {
    const { cookies } = await login();
    const hidden = await t.db.scenario.create({
      data: {
        title: '非公開',
        summary: 's',
        introText: 'i',
        endingText: 'e',
        status: 'hidden_by_report',
      },
    });
    try {
      const res = await t.app.inject({ method: 'GET', url: '/scenarios/available', cookies });
      const ids = (res.json().scenarios as { id: string }[]).map((x) => x.id);
      expect(ids).not.toContain(hidden.id);
    } finally {
      await t.db.scenario.delete({ where: { id: hidden.id } });
    }
  });
});

describe('GET /scenarios/:id', () => {
  it('概要のみを返し、冒頭文・結末文・キャラの状況文は含まない', async () => {
    const { cookies } = await login();
    const s = await t.db.scenario.findUniqueOrThrow({ where: { slug: '001-yukiyama-sansou' } });
    const res = await t.app.inject({ method: 'GET', url: `/scenarios/${s.id}`, cookies });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().scenario).sort()).toEqual([
      'id',
      'publishedAt',
      'summary',
      'title',
    ]);
    expect(res.body).not.toContain('犯人は、医師');
  });

  it('存在しないID・不正なIDは404', async () => {
    const { cookies } = await login();
    const none = await t.app.inject({
      method: 'GET',
      url: '/scenarios/00000000-0000-4000-8000-000000000000',
      cookies,
    });
    expect(none.statusCode).toBe(404);
    const bad = await t.app.inject({ method: 'GET', url: '/scenarios/not-a-uuid', cookies });
    expect(bad.statusCode).toBe(404);
  });
});
