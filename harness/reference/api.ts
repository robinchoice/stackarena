// In-memory reference backend. It exists only to prove that the API tests, the contract run and the
// load test are correct. The orchestrator removes this folder from every team's worktree.
import { type SchemaName, problems } from '../lib/spec';
import type { CheckIn, Habit } from '../seed/rules';

const PAGE = 5000;
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW = 15 * 60_000;

const MESSAGES = {
  en: {
    unauthorized: 'Please sign in again.',
    badLogin: 'Email or password is wrong.',
    taken: 'This email is already registered.',
    invalid: 'The request is invalid: ',
    unknownHabit: 'A check-in refers to an unknown habit.',
    tooMany: 'Too many attempts. Try again later.',
    notFound: 'Not found.',
    method: 'Method not allowed.',
  },
  de: {
    unauthorized: 'Bitte melde dich erneut an.',
    badLogin: 'E-Mail oder Passwort ist falsch.',
    taken: 'Diese E-Mail ist schon registriert.',
    invalid: 'Die Anfrage ist ungültig: ',
    unknownHabit: 'Ein Eintrag verweist auf eine unbekannte Gewohnheit.',
    tooMany: 'Zu viele Versuche. Versuche es später noch einmal.',
    notFound: 'Nicht gefunden.',
    method: 'Methode nicht erlaubt.',
  },
};
type Lang = keyof typeof MESSAGES;

interface User {
  id: string;
  email: string;
  password: string;
  createdAt: string;
}
interface Stored<T> {
  rec: T;
  seq: number;
}
interface Store {
  seq: number;
  habits: Map<string, Stored<Habit>>;
  checkins: Map<string, Stored<CheckIn>>;
}

const users = new Map<string, User>();
const tokens = new Map<string, string>();
const stores = new Map<string, Store>();
const failures = new Map<string, number[]>();

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'retry-after',
};
const json = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { ...CORS, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
  });

// Later updatedAt wins, on a tie the larger deviceId
const wins = (a: { updatedAt: string; deviceId: string }, b: { updatedAt: string; deviceId: string }) => {
  const d = Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
  return d !== 0 ? d > 0 : a.deviceId > b.deviceId;
};

const randomToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

async function handle(req: Request): Promise<Response> {
  const lang: Lang = (req.headers.get('accept-language') ?? '').toLowerCase().startsWith('de') ? 'de' : 'en';
  const m = MESSAGES[lang];
  const error = (status: number, message: string, headers?: Record<string, string>) =>
    json(status, { error: message }, headers);
  const { pathname } = new URL(req.url);
  const route = `${req.method} ${pathname}`;

  const body = async (schema: SchemaName): Promise<[unknown, Response | null]> => {
    let data: unknown;
    try {
      data = await req.json();
    } catch {
      return [null, error(422, `${m.invalid}JSON`)];
    }
    const p = problems(schema, data);
    return p ? [null, error(422, m.invalid + p)] : [data, null];
  };
  const auth = (): User | null => {
    const h = req.headers.get('authorization') ?? '';
    const id = h.startsWith('Bearer ') ? tokens.get(h.slice(7)) : undefined;
    return id ? ([...users.values()].find((u) => u.id === id) ?? null) : null;
  };
  const session = (u: User) => {
    const token = randomToken();
    tokens.set(token, u.id);
    return { token, user: { id: u.id, email: u.email, createdAt: u.createdAt } };
  };

  if (req.method === 'OPTIONS')
    return json(204, undefined, {
      'access-control-allow-methods': 'GET, POST',
      'access-control-allow-headers': 'authorization, content-type, accept-language',
      'access-control-max-age': '600',
    });

  switch (route) {
    case 'GET /health':
      return json(200, { status: 'ok' });

    case 'POST /auth/register': {
      const [data, bad] = await body('Credentials');
      if (bad) return bad;
      const { email, password } = data as { email: string; password: string };
      const key = email.toLowerCase();
      if (users.has(key)) return error(409, m.taken);
      const u: User = {
        id: crypto.randomUUID(),
        email,
        password: await Bun.password.hash(password, 'argon2id'),
        createdAt: new Date().toISOString(),
      };
      users.set(key, u);
      stores.set(u.id, { seq: 0, habits: new Map(), checkins: new Map() });
      return json(201, session(u));
    }

    case 'POST /auth/login': {
      const [data, bad] = await body('Credentials');
      if (bad) return bad;
      const { email, password } = data as { email: string; password: string };
      const key = email.toLowerCase();
      const now = Date.now();
      const recent = (failures.get(key) ?? []).filter((t) => now - t < LOGIN_WINDOW);
      failures.set(key, recent);
      if (recent.length >= LOGIN_LIMIT) {
        const retry = Math.ceil((recent[0]! + LOGIN_WINDOW - now) / 1000);
        return error(429, m.tooMany, { 'retry-after': String(Math.max(1, retry)) });
      }
      const u = users.get(key);
      if (!u || !(await Bun.password.verify(password, u.password))) {
        recent.push(now);
        return error(401, m.badLogin);
      }
      return json(200, session(u));
    }

    case 'POST /auth/logout': {
      const h = req.headers.get('authorization') ?? '';
      if (!auth()) return error(401, m.unauthorized);
      tokens.delete(h.slice(7));
      return json(204);
    }

    case 'GET /me': {
      const u = auth();
      if (!u) return error(401, m.unauthorized);
      return json(200, { id: u.id, email: u.email, createdAt: u.createdAt });
    }

    case 'POST /sync': {
      const u = auth();
      if (!u) return error(401, m.unauthorized);
      const [data, bad] = await body('SyncRequest');
      if (bad) return bad;
      const { cursor, habits, checkins } = data as { cursor: string | null; habits: Habit[]; checkins: CheckIn[] };
      const store = stores.get(u.id)!;
      // An unknown cursor counts as null, so the client gets everything again
      const match = cursor === null ? null : /^s(\d+)$/.exec(cursor);
      const since = match && Number(match[1]) <= store.seq ? Number(match[1]) : 0;
      const known = new Set([...store.habits.keys(), ...habits.map((h) => h.id)]);
      if (checkins.some((c) => !known.has(c.habitId))) return error(422, m.unknownHabit);

      for (const h of habits) {
        const old = store.habits.get(h.id);
        if (!old || wins(h, old.rec)) store.habits.set(h.id, { rec: h, seq: ++store.seq });
      }
      for (const c of checkins) {
        const key = `${c.habitId}|${c.date}`;
        const old = store.checkins.get(key);
        if (!old || wins(c, old.rec)) store.checkins.set(key, { rec: c, seq: ++store.seq });
      }

      const changed = [
        ...[...store.habits.values()].map((s) => ({ ...s, kind: 'habit' as const })),
        ...[...store.checkins.values()].map((s) => ({ ...s, kind: 'checkin' as const })),
      ]
        .filter((s) => s.seq > since)
        .sort((a, b) => a.seq - b.seq);
      const page = changed.slice(0, PAGE);
      const last = page.length ? page[page.length - 1]!.seq : store.seq;
      return json(200, {
        cursor: `s${changed.length > PAGE ? last : store.seq}`,
        hasMore: changed.length > PAGE,
        habits: page.filter((s) => s.kind === 'habit').map((s) => s.rec),
        checkins: page.filter((s) => s.kind === 'checkin').map((s) => s.rec),
      });
    }
  }
  const allow: Record<string, string> = {
    '/health': 'GET',
    '/auth/register': 'POST',
    '/auth/login': 'POST',
    '/auth/logout': 'POST',
    '/me': 'GET',
    '/sync': 'POST',
  };
  return allow[pathname] ? error(405, m.method, { allow: allow[pathname] }) : error(404, m.notFound);
}

const server = Bun.serve({ port: Number(process.env.PORT ?? 18080), hostname: process.env.HOST ?? '127.0.0.1', fetch: handle });
console.log(`reference api on ${server.url}`);
