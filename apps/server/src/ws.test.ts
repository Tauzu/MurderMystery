import type { AddressInfo } from 'node:net';
import type { RoomView, ServerMessage } from '@mm/game-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { seedScenarios } from './seed';
import { cleanupTestUsers, createTestApp, uniqueEmail } from './test-helpers';
import { fileURLToPath } from 'node:url';

const t = createTestApp();
const gameIds: string[] = [];
let port = 0;
let scenarioId = '';

/** サーバーからのメッセージを溜めて、条件を満たすまで待てるクライアント。 */
class Client {
  messages: ServerMessage[] = [];
  closed: Promise<number>;
  private waiters: { test: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] =
    [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (!w.test(msg)) return true;
        w.resolve(msg);
        return false;
      });
    });
    this.closed = new Promise((resolve) => ws.on('close', (code: number) => resolve(code)));
  }

  static async connect(roomId: string, cookie?: string, origin?: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?roomId=${roomId}`, {
      headers: {
        ...(cookie ? { Cookie: `mm_session=${cookie}` } : {}),
        ...(origin ? { Origin: origin } : {}),
      },
    });
    const client = new Client(ws);
    await new Promise<void>((resolve) => {
      ws.on('open', () => resolve());
      ws.on('close', () => resolve());
    });
    return client;
  }

  send(msg: object) {
    this.ws.send(JSON.stringify(msg));
  }

  waitFor(test: (m: ServerMessage) => boolean, timeoutMs = 5000): Promise<ServerMessage> {
    const found = this.messages.find(test);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('待機がタイムアウトしました')), timeoutMs);
      this.waiters.push({
        test,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  /** 次に届く、条件を満たす snapshot を待つ（過去のメッセージは見ない）。 */
  async nextView(test: (v: RoomView) => boolean): Promise<RoomView> {
    const from = this.messages.length;
    const matches = (m: ServerMessage) => m.type === 'snapshot' && test(m.view);
    const past = this.messages.slice(from).find(matches);
    if (past && past.type === 'snapshot') return past.view;
    const m = await this.waitFor((x) => matches(x) && this.messages.indexOf(x) >= from);
    return (m as Extract<ServerMessage, { type: 'snapshot' }>).view;
  }

  lastView(): RoomView {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!;
      if (m.type === 'snapshot') return m.view;
    }
    throw new Error('snapshot がまだ届いていません');
  }

  close() {
    this.ws.close();
  }
}

async function register() {
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
  return {
    userId: res.json().user.id as string,
    cookie: res.cookies.find((c) => c.name === 'mm_session')!.value,
  };
}

async function match(cookie: string, size: number, id = scenarioId) {
  return t.app.inject({
    method: 'POST',
    url: '/matches',
    cookies: { mm_session: cookie },
    payload: { scenarioId: id, size },
  });
}

async function currentMatch(cookie: string) {
  const res = await t.app.inject({
    method: 'GET',
    url: '/matches/current',
    cookies: { mm_session: cookie },
  });
  return res.json() as { status: string; roomId?: string };
}

/** 4人をマッチングさせ、ルームIDを返す。 */
async function startFourPlayerGame() {
  const players = [await register(), await register(), await register(), await register()];
  for (const p of players) expect((await match(p.cookie, 4)).statusCode).toBe(202);
  const current = await currentMatch(players[0]!.cookie);
  expect(current.status).toBe('matched');
  gameIds.push(current.roomId!);
  return { roomId: current.roomId!, players };
}

beforeAll(async () => {
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  port = (t.app.server.address() as AddressInfo).port;
  await seedScenarios(t.db, fileURLToPath(new URL('../../../scenarios', import.meta.url)));
  scenarioId = (await t.db.scenario.findUniqueOrThrow({ where: { slug: '001-yukiyama-sansou' } }))
    .id;
});

afterAll(async () => {
  await t.db.game.deleteMany({ where: { id: { in: gameIds } } });
  // 保存された状態が残ると、次にサーバーを起動したとき復元されてしまう
  for (const id of gameIds) await t.redis.del(`room:${id}:state`);
  await cleanupTestUsers(t.db);
  await t.close();
});

describe('マッチング', () => {
  it('4人集まるとルームが作られ、それまでは待機中になる', async () => {
    const a = await register();
    const first = await match(a.cookie, 4);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ status: 'waiting', size: 4, waiting: 1 });

    const dup = await match(a.cookie, 4);
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('already_queued');

    const cancel = await t.app.inject({
      method: 'DELETE',
      url: '/matches/current',
      cookies: { mm_session: a.cookie },
    });
    expect(cancel.statusCode).toBe(204);
    expect((await currentMatch(a.cookie)).status).toBe('none');
  });

  it('1人で遊ぶと、残りの3席がNPCのルームがすぐに作られる', async () => {
    const a = await register();
    expect((await match(a.cookie, 1)).statusCode).toBe(202);
    const cur = await currentMatch(a.cookie);
    expect(cur.status).toBe('matched');
    gameIds.push(cur.roomId!);
    const state = t.app.deps.rooms.getState(cur.roomId!)!.state;
    expect(state.seats.filter((s) => s.kind === 'npc')).toHaveLength(3);
  });

  it('プレイ済み・不正な人数・存在しないシナリオ・ゲーム中は拒否される', async () => {
    const a = await register();
    expect((await match(a.cookie, 0)).statusCode).toBe(400);
    expect((await match(a.cookie, 5)).statusCode).toBe(400);
    expect((await match(a.cookie, 4, '00000000-0000-4000-8000-000000000000')).json().code).toBe(
      'scenario_unavailable',
    );

    await t.db.playedScenario.create({ data: { userId: a.userId, scenarioId } });
    expect((await match(a.cookie, 4)).json().code).toBe('already_played');

    const b = await register();
    expect((await match(b.cookie, 1)).statusCode).toBe(202);
    gameIds.push((await currentMatch(b.cookie)).roomId!);
    expect((await match(b.cookie, 1)).json().code).toBe('in_game');
  });

  it('未ログインは401', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/matches', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe('WebSocket：接続', () => {
  it('未ログイン・参加者でない人・存在しないルームは拒否される', async () => {
    const { roomId, players } = await startFourPlayerGame();
    const outsider = await register();

    const anon = await Client.connect(roomId);
    expect(await anon.closed).toBe(4401);

    const stranger = await Client.connect(roomId, outsider.cookie);
    expect(await stranger.closed).toBe(4403);

    const missing = await Client.connect(
      '00000000-0000-4000-8000-000000000000',
      players[0]!.cookie,
    );
    expect(await missing.closed).toBe(4404);
  });

  it('許可されていないオリジンからの接続は拒否される', async () => {
    const { roomId, players } = await startFourPlayerGame();
    const evil = await Client.connect(roomId, players[0]!.cookie, 'http://evil.example');
    expect(await evil.closed).toBe(4403);

    const ok = await Client.connect(roomId, players[0]!.cookie, 'http://localhost:3000');
    await ok.waitFor((m) => m.type === 'snapshot');
    ok.close();
  });

  it('接続すると自分用の snapshot が届き、不正なメッセージにはエラーが返る', async () => {
    const { roomId, players } = await startFourPlayerGame();
    const c = await Client.connect(roomId, players[0]!.cookie);
    const first = await c.waitFor((m) => m.type === 'snapshot');
    expect(first).toMatchObject({ type: 'snapshot', spectator: false });
    expect(c.lastView().phase).toBe('INTRO');

    c.ws.send('これはJSONではない');
    c.send({ type: 'unknown' });
    c.send({ type: 'vote', targetSeat: 'x' });
    await c.waitFor((m) => m.type === 'error');
    expect(c.messages.filter((m) => m.type === 'error')).toHaveLength(3);

    c.send({ type: 'ping' });
    await c.waitFor((m) => m.type === 'pong');
    c.send({ type: 'vote', targetSeat: 1 });
    await c.waitFor((m) => m.type === 'error' && m.code === 'wrong_phase');
    c.close();
  });
});

describe('WebSocket：4人で最後まで遊ぶ', () => {
  it('全員が操作して結果まで進み、途中で他人の秘密は一度も届かない', async () => {
    const { roomId, players } = await startFourPlayerGame();
    const clients = await Promise.all(players.map((p) => Client.connect(roomId, p.cookie)));
    await Promise.all(clients.map((c) => c.waitFor((m) => m.type === 'snapshot')));

    const all = (fn: (c: Client, seat: number) => Promise<unknown>) =>
      Promise.all(clients.map((c, i) => fn(c, c.lastView().me.seat ?? i)));
    const phaseIs = (phase: string, setNo?: number) => (v: RoomView) =>
      v.phase === phase && (setNo === undefined || v.setNo === setNo);

    // 導入 → 確認 → 第1セット
    await all(async (c) => {
      const next = c.nextView(phaseIs('CONFIRM'));
      c.send({ type: 'ready' });
      await next;
    });
    await all(async (c) => {
      const next = c.nextView(phaseIs('REVEAL', 1));
      c.send({ type: 'ready' });
      await next;
    });

    for (let set = 1; set <= 3; set++) {
      // 各自、手札を公開させる相手を指名する
      await all(async (c) => {
        const target = c.lastView().pickableSeats[0]!;
        const next = c.nextView(phaseIs('TALK', set));
        c.send({ type: 'pickTarget', target });
        await next;
      });
      // 4枚が同時に公開されている
      for (const c of clients) expect(c.lastView().revealed).toHaveLength(set * 4);

      clients[set % 4]!.send({ type: 'chat', body: `セット${set}の発言` });
      await clients[0]!.waitFor(
        (m) => m.type === 'snapshot' && m.view.chat.some((x) => x.body === `セット${set}の発言`),
      );
      const done = set < 3 ? phaseIs('REVEAL', set + 1) : phaseIs('VOTE');
      await all(async (c) => {
        const next = c.nextView(done);
        c.send({ type: 'agreeEndTalk' });
        await next;
      });
    }

    await all(async (c) => {
      const me = c.lastView().me.seat;
      const next = c.nextView(phaseIs('RESULT'));
      c.send({ type: 'vote', targetSeat: (me + 1) % 4 });
      await next;
    });

    // 結果：全員が同じ犯人・勝敗・全員の手札を見られる
    const results = clients.map((c) => c.lastView().resultView!);
    expect(results.every((r) => r.result.winner === results[0]!.result.winner)).toBe(true);
    expect(results[0]!.hands.flatMap((h) => h.cards)).toHaveLength(16);
    expect(results[0]!.endingText).toContain('犯人は、医師の白石葵');

    // 途中の snapshot に、他人の秘密が含まれていないこと（結果画面を除く）
    const characters = await t.db.character.findMany({
      where: { scenarioId },
      include: { cards: true },
    });
    for (const c of clients) {
      const seat = c.lastView().me.seat;
      const mine = c.lastView().seats.find((s) => s.seat === seat)!.characterId;
      for (const m of c.messages) {
        if (m.type !== 'snapshot' || m.view.phase === 'RESULT' || m.view.phase === 'CLOSED') {
          continue;
        }
        const json = JSON.stringify(m.view);
        const revealedBodies = new Set(m.view.revealed.map((r) => r.card.body));
        for (const ch of characters) {
          if (ch.id === mine) continue;
          expect(json).not.toContain(ch.situationText);
          for (const card of ch.cards) {
            if (revealedBodies.has(card.body)) continue;
            // 犯人には、他人の手札にある捏造カードも見える（仕様書 §4.3.1）
            if (card.isFabricated && m.view.me.isCulprit) continue;
            expect(json).not.toContain(card.body);
          }
        }
        // どれが捏造かは、犯人以外に伝えない
        if (!m.view.me.isCulprit) expect(m.view.me.fabricatedCard).toBeNull();
        expect(json).not.toContain('"fabricated"');
        expect(json).not.toContain('犯人は、医師の白石葵');
      }
    }

    // DBに保存されている（結果が出た直後）
    await expect
      .poll(async () => (await t.db.game.findUnique({ where: { id: roomId } }))?.status)
      .toBe('finished');
    for (const c of clients) c.close();
  }, 30_000);
});

describe('WebSocket：観戦とレート制限', () => {
  it('発言は連続して送れない', async () => {
    const { roomId, players } = await startFourPlayerGame();
    const clients = await Promise.all(players.map((p) => Client.connect(roomId, p.cookie)));
    await Promise.all(clients.map((c) => c.waitFor((m) => m.type === 'snapshot')));
    for (const c of clients) c.send({ type: 'ready' });
    await Promise.all(clients.map((c) => c.nextView((v) => v.phase === 'CONFIRM')));
    for (const c of clients) c.send({ type: 'ready' });
    await Promise.all(clients.map((c) => c.nextView((v) => v.phase === 'REVEAL')));
    for (const c of clients) {
      c.send({ type: 'pickTarget', target: c.lastView().pickableSeats[0]! });
    }
    await Promise.all(clients.map((c) => c.nextView((v) => v.phase === 'TALK')));

    const c = clients[0]!;
    c.send({ type: 'chat', body: '1回目' });
    c.send({ type: 'chat', body: '2回目' });
    await c.waitFor((m) => m.type === 'error' && m.code === 'rate_limited');
    await c.waitFor((m) => m.type === 'snapshot' && m.view.chat.some((x) => x.body === '1回目'));
    expect(c.lastView().chat.filter((x) => x.body === '1回目')).toHaveLength(1);
    for (const x of clients) x.close();
  });

  it('NPCに切り替わった元のプレイヤーは観戦になり、操作できない', async () => {
    const { roomId, players } = await startFourPlayerGame();
    const c = await Client.connect(roomId, players[0]!.cookie);
    await c.waitFor((m) => m.type === 'snapshot');
    const seat = c.lastView().me.seat;

    await t.app.deps.rooms.dispatch(roomId, { type: 'SwitchToNpc', seat });
    await c.waitFor((m) => m.type === 'switched');
    await c.waitFor(
      (m) => m.type === 'snapshot' && m.view.seats.find((x) => x.seat === seat)?.kind === 'npc',
    );
    const last = c.messages.filter((m) => m.type === 'snapshot').at(-1)!;
    expect(last).toMatchObject({ spectator: true });

    c.send({ type: 'ready' });
    await c.waitFor((m) => m.type === 'error' && m.code === 'spectator');
    // 観戦者は resync で最新の状態を取得できる
    c.send({ type: 'resync' });
    c.close();
  });
});

describe('WebSocket：再接続', () => {
  it('切断して再接続すると、同じ席で、会話と公開カードがそのまま戻る', async () => {
    const { roomId, players } = await startFourPlayerGame();
    const rooms = t.app.deps.rooms;
    const first = await Client.connect(roomId, players[0]!.cookie);
    await first.waitFor((m) => m.type === 'snapshot');
    const seat = first.lastView().me.seat;

    // 第1セットの会話まで進める
    for (let phase = 0; phase < 2; phase++) {
      for (const s of [0, 1, 2, 3]) await rooms.dispatch(roomId, { type: 'Ready', seat: s });
    }
    for (const s of [0, 1, 2, 3]) {
      await rooms.dispatch(roomId, { type: 'PickTarget', seat: s, target: (s + 1) % 4 });
    }
    first.send({ type: 'chat', body: '切断前の発言' });
    await first.waitFor(
      (m) => m.type === 'snapshot' && m.view.chat.some((x) => x.body === '切断前の発言'),
    );

    first.close();
    await first.closed;

    const second = await Client.connect(roomId, players[0]!.cookie);
    await second.waitFor((m) => m.type === 'snapshot');
    const view = second.lastView();
    expect(view.me.seat).toBe(seat);
    expect(view.phase).toBe('TALK');
    expect(view.revealed).toHaveLength(4);
    expect(view.chat.map((x) => x.body)).toContain('切断前の発言');
    expect(view.seats.find((s) => s.seat === seat)?.kind).toBe('human');
    second.close();
  });
});
