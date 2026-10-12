import { describe, expect, it } from 'vitest';
import { buildApp } from './app';

describe('GET /health', () => {
  it('200 と status:ok を返す', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
