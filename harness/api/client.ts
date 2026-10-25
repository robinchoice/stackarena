import { type SchemaName, problems } from '../lib/spec';
import type { CheckIn, Habit } from '../seed/rules';

export const BASE_URL = (process.env.BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
export const PASSWORD = 'correct-horse-battery';

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

// Calls the API and checks the response body against the schema from the spec
export async function call<T = any>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; raw?: string; lang?: string; schema?: SchemaName } = {},
): Promise<Res<T>> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.lang) headers['accept-language'] = opts.lang;
  if (opts.body !== undefined || opts.raw !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE_URL + path, {
    method,
    headers,
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  const schema = res.status >= 400 ? 'Error' : opts.schema;
  if (schema) {
    const p = problems(schema, body);
    if (p) throw new Error(`${method} ${path} → ${res.status}: response does not match ${schema}: ${p}`);
  }
  return { status: res.status, body, headers: res.headers };
}

let counter = 0;
export const uniqueEmail = (tag: string) =>
  `${tag}-${Date.now().toString(36)}-${(counter++).toString(36)}@stackarena.test`;

export async function register(tag = 'user'): Promise<{ token: string; email: string }> {
  const email = uniqueEmail(tag);
  const res = await call('POST', '/auth/register', { body: { email, password: PASSWORD }, schema: 'Session' });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.token, email };
}

export interface SyncBody {
  cursor: string;
  hasMore: boolean;
  habits: Habit[];
  checkins: CheckIn[];
}

export const sync = (
  token: string,
  push: { deviceId?: string; cursor?: string | null; habits?: Habit[]; checkins?: CheckIn[] } = {},
) =>
  call<SyncBody>('POST', '/sync', {
    token,
    schema: 'SyncResponse',
    body: {
      deviceId: push.deviceId ?? 'test-device',
      cursor: push.cursor ?? null,
      habits: push.habits ?? [],
      checkins: push.checkins ?? [],
    },
  });

// Pulls every page and returns all records the server has for the user
export async function pullAll(token: string, deviceId = 'puller') {
  const habits: Habit[] = [];
  const checkins: CheckIn[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const res = await sync(token, { deviceId, cursor });
    if (res.status !== 200) throw new Error(`sync failed: ${res.status}`);
    if (res.body.habits.length + res.body.checkins.length > 5000)
      throw new Error('sync response exceeds 5000 records');
    habits.push(...res.body.habits);
    checkins.push(...res.body.checkins);
    cursor = res.body.cursor;
    pages++;
    if (!res.body.hasMore) return { habits, checkins, cursor, pages };
  }
}

// Pushes a large dataset in chunks the API accepts
export async function pushAll(token: string, habits: Habit[], checkins: CheckIn[], deviceId = 'seed') {
  let cursor: string | null = null;
  for (let i = 0; i === 0 || i < checkins.length; i += 5000) {
    const res = await sync(token, { deviceId, cursor, habits: i === 0 ? habits : [], checkins: checkins.slice(i, i + 5000) });
    if (res.status !== 200) throw new Error(`push failed: ${res.status} ${JSON.stringify(res.body)}`);
    cursor = res.body.cursor;
  }
}

export function habit(over: Partial<Habit> = {}): Habit {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: 'Test habit',
    icon: 'drop',
    color: 3,
    rhythm: { type: 'daily' },
    targetPerDay: 1,
    reminder: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    deviceId: 'test-device',
    ...over,
  };
}

export function checkin(habitId: string, over: Partial<CheckIn> = {}): CheckIn {
  return { habitId, date: '2026-10-01', count: 1, updatedAt: new Date().toISOString(), deviceId: 'test-device', ...over };
}
