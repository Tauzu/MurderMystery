import { hash, verify } from '@node-rs/argon2';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { SESSION_COOKIE, SESSION_TTL_SEC, createSession, destroySession } from '../session';

const registerBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(20),
  agreeAge: z.literal(true),
});

const loginBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

const invalid = (reply: FastifyReply) =>
  reply.code(400).send({ code: 'invalid_request', message: '入力内容が正しくありません' });

export async function authRoutes(app: FastifyInstance) {
  const { db, redis, secureCookies } = app.deps;

  const startSession = async (reply: FastifyReply, userId: string) => {
    const sid = await createSession(redis, userId);
    reply.setCookie(SESSION_COOKIE, sid, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies ?? false,
      path: '/',
      maxAge: SESSION_TTL_SEC,
    });
  };

  app.post('/auth/register', async (request, reply) => {
    const body = registerBody.safeParse(request.body);
    if (!body.success) return invalid(reply);
    const { email, password, displayName } = body.data;
    const normalized = email.toLowerCase();

    if (await db.user.findUnique({ where: { email: normalized } })) {
      return reply
        .code(409)
        .send({ code: 'email_taken', message: 'このメールアドレスは使われています' });
    }
    const user = await db.user.create({
      data: {
        email: normalized,
        passwordHash: await hash(password),
        displayName,
        agreedAgeAt: new Date(),
      },
    });
    await startSession(reply, user.id);
    return reply.code(201).send({ user: { id: user.id, displayName: user.displayName } });
  });

  app.post('/auth/login', async (request, reply) => {
    const body = loginBody.safeParse(request.body);
    if (!body.success) return invalid(reply);

    const user = await db.user.findUnique({ where: { email: body.data.email.toLowerCase() } });
    const ok =
      user?.passwordHash && user.status === 'active'
        ? await verify(user.passwordHash, body.data.password)
        : false;
    if (!user || !ok) {
      return reply
        .code(401)
        .send({ code: 'invalid_credentials', message: 'メールアドレスまたはパスワードが違います' });
    }
    await startSession(reply, user.id);
    return { user: { id: user.id, displayName: user.displayName } };
  });

  app.post('/auth/logout', async (request, reply) => {
    const sid = request.cookies[SESSION_COOKIE];
    if (sid) await destroySession(redis, sid);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/me', async (request, reply) => {
    const userId = await app.requireUserId(request, reply);
    if (!userId) return;
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user) return reply.code(401).send({ code: 'unauthorized', message: 'ログインが必要です' });
    return { user: { id: user.id, displayName: user.displayName } };
  });
}
