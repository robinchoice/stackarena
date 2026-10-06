import { describe, expect, test } from 'bun:test';
import { BASE_URL, PASSWORD, call, register, uniqueEmail } from './client';

describe('health', () => {
  test('answers ok without a token', async () => {
    const res = await call('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('register', () => {
  test('creates an account and returns a working token', async () => {
    const email = uniqueEmail('reg');
    const res = await call('POST', '/auth/register', { body: { email, password: PASSWORD }, schema: 'Session' });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(email);
    const me = await call('GET', '/me', { token: res.body.token, schema: 'User' });
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(res.body.user.id);
  });

  test('rejects an email that exists, ignoring case', async () => {
    const { email } = await register('dup');
    const res = await call('POST', '/auth/register', { body: { email: email.toUpperCase(), password: PASSWORD } });
    expect(res.status).toBe(409);
  });

  test.each([
    ['no email', { password: PASSWORD }],
    ['bad email', { email: 'not-an-email', password: PASSWORD }],
    ['short password', { email: uniqueEmail('short'), password: 'short' }],
    ['extra field', { email: uniqueEmail('extra'), password: PASSWORD, name: 'x' }],
  ])('rejects %s with 422', async (_, body) => {
    const res = await call('POST', '/auth/register', { body });
    expect(res.status).toBe(422);
  });

  test('rejects a body that is not JSON with 422', async () => {
    const res = await call('POST', '/auth/register', { raw: '{"email":' });
    expect(res.status).toBe(422);
  });
});

describe('login', () => {
  test('signs in with the right password, any email case', async () => {
    const { email } = await register('login');
    const res = await call('POST', '/auth/login', { body: { email: email.toUpperCase(), password: PASSWORD }, schema: 'Session' });
    expect(res.status).toBe(200);
    expect((await call('GET', '/me', { token: res.body.token })).status).toBe(200);
  });

  test('rejects a wrong password and an unknown email with 401', async () => {
    const { email } = await register('wrong');
    expect((await call('POST', '/auth/login', { body: { email, password: 'wrong-password' } })).status).toBe(401);
    expect((await call('POST', '/auth/login', { body: { email: uniqueEmail('nobody'), password: PASSWORD } })).status).toBe(401);
  });

  test('locks the email after 10 failed attempts', async () => {
    const { email } = await register('lock');
    for (let i = 0; i < 10; i++) {
      expect((await call('POST', '/auth/login', { body: { email, password: 'wrong-password' } })).status).toBe(401);
    }
    const locked = await call('POST', '/auth/login', { body: { email, password: PASSWORD } });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
  }, 30_000);
});

describe('session', () => {
  test('rejects missing and unknown tokens', async () => {
    expect((await call('GET', '/me')).status).toBe(401);
    expect((await call('GET', '/me', { token: 'x'.repeat(43) })).status).toBe(401);
    expect((await call('POST', '/sync', { body: { deviceId: 'd', cursor: null, habits: [], checkins: [] } })).status).toBe(401);
  });

  test('logout revokes only the current token', async () => {
    const { token, email } = await register('logout');
    const other = (await call('POST', '/auth/login', { body: { email, password: PASSWORD } })).body.token;
    expect((await call('POST', '/auth/logout', { token })).status).toBe(204);
    expect((await call('GET', '/me', { token })).status).toBe(401);
    expect((await call('GET', '/me', { token: other })).status).toBe(200);
  });
});

describe('http', () => {
  test('unknown paths answer 404, unsupported methods 405', async () => {
    expect((await call('GET', '/nope')).status).toBe(404);
    const res = await call('DELETE', '/me');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
    expect((await call('GET', '/sync')).status).toBe(405);
  });
});

describe('cors', () => {
  test('every response allows any origin, preflight answers 204', async () => {
    const res = await fetch(`${BASE_URL}/health`, { headers: { origin: 'http://localhost:5173' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const pre = await fetch(`${BASE_URL}/sync`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type',
      },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');
    expect(pre.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
  });
});

describe('errors', () => {
  test('follow Accept-Language', async () => {
    const de = await call('GET', '/me', { lang: 'de-DE,de;q=0.9' });
    const en = await call('GET', '/me', { lang: 'en' });
    const fallback = await call('GET', '/me', { lang: 'fr' });
    expect(de.status).toBe(401);
    expect(de.body.error).not.toBe(en.body.error);
    expect(fallback.body.error).toBe(en.body.error);
  });
});
