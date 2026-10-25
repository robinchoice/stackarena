// Reference CLI after spec/cli.md on top of the rule reference, so the CLI tests can be validated
// without a team. Local data lives in one JSON file in STACKARENA_HOME.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { CheckIn, Habit } from '../seed/rules';
import { Rules, localDate, monday, percent, toDay } from '../seed/rules';
import { assertValid } from '../lib/spec';

interface State {
  deviceId: string;
  token: string | null;
  cursor: string | null;
  habits: Habit[];
  checkins: CheckIn[];
  dirty: string[]; // keys of records changed since the last sync
}

const home = process.env.STACKARENA_HOME;
if (!home) fail('STACKARENA_HOME is not set');
const file = `${home}/state.json`;
const api = (process.env.STACKARENA_API_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const state: State = existsSync(file)
  ? JSON.parse(readFileSync(file, 'utf8'))
  : { deviceId: crypto.randomUUID(), token: null, cursor: null, habits: [], checkins: [], dirty: [] };

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
const save = () => {
  mkdirSync(home!, { recursive: true });
  writeFileSync(file, JSON.stringify(state));
};
const print = (v: unknown) => console.log(JSON.stringify(v));
const checkinKey = (c: CheckIn) => `${c.habitId}/${c.date}`;
const newer = (a: Habit | CheckIn, b: Habit | CheckIn) =>
  a.updatedAt === b.updatedAt ? a.deviceId > b.deviceId : Date.parse(a.updatedAt) > Date.parse(b.updatedAt);

// Last-write-wins merge, as on the server; returns whether the record was taken
function mergeHabit(h: Habit) {
  const i = state.habits.findIndex((x) => x.id === h.id);
  if (i >= 0 && !newer(h, state.habits[i]!)) return false;
  if (i >= 0) state.habits[i] = h;
  else state.habits.push(h);
  return true;
}
function mergeCheckin(c: CheckIn) {
  const i = state.checkins.findIndex((x) => checkinKey(x) === checkinKey(c));
  if (i >= 0 && !newer(c, state.checkins[i]!)) return false;
  if (i >= 0) state.checkins[i] = c;
  else state.checkins.push(c);
  return true;
}
const touch = (key: string) => state.dirty.includes(key) || state.dirty.push(key);
// Local changes always apply here; last-write-wins decides only between devices
function putHabit(h: Habit) {
  state.habits = [...state.habits.filter((x) => x.id !== h.id), h];
  touch(h.id);
}
function putCheckin(c: CheckIn) {
  state.checkins = [...state.checkins.filter((x) => checkinKey(x) !== checkinKey(c)), c];
  touch(checkinKey(c));
}

const today = localDate(new Date().toISOString(), tz);
const rules = () => new Rules(state.habits, state.checkins, toDay(today), tz);
function habitById(id: string | undefined) {
  const h = state.habits.find((x) => x.id === id);
  if (!h) fail(`unknown habit ${id}`);
  return h;
}
function habitState(r: Rules, h: Habit) {
  const t = r.today;
  return {
    id: h.id,
    name: h.name,
    archived: h.archivedAt !== null,
    dueToday: h.archivedAt === null && r.isDue(h, t),
    countToday: r.count(h, t),
    doneToday: r.isDone(h, t),
    currentStreak: r.currentStreak(h),
    longestStreak: r.longestStreak(h),
    rate30: percent(r.rate([h], t - 29, t)),
  };
}

const FIELDS = ['name', 'icon', 'color', 'rhythm', 'targetPerDay', 'reminder'] as const;
function parseFields(json: string | undefined, all: boolean): Partial<Habit> {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(json ?? '');
  } catch {
    fail('expected a JSON object');
  }
  const unknown = Object.keys(v).filter((k) => !(FIELDS as readonly string[]).includes(k));
  if (unknown.length) fail(`unknown fields: ${unknown.join(', ')}`);
  if (all && FIELDS.some((k) => !(k in v))) fail(`required: ${FIELDS.join(', ')}`);
  return v as Partial<Habit>;
}
function writeHabit(h: Habit) {
  try {
    assertValid('Habit', h);
  } catch (e) {
    fail(String(e));
  }
  putHabit(h);
  save();
  print(h);
}

async function request(path: string, body: unknown, token?: string | null) {
  const res = await fetch(api + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).catch((e) => fail(`no connection to ${api}: ${e}`));
  const text = await res.text();
  if (!res.ok) fail(`${path} answered ${res.status}: ${text}`);
  return JSON.parse(text);
}

const csvCell = (v: string | number | null) => {
  const s = v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const CSV_HEAD =
  'habit_id,habit_name,icon,color,rhythm,times_per_week,days,target_per_day,reminder,created_at,archived_at,date,count';
function toCsv(r: Rules) {
  const rows = [CSV_HEAD];
  for (const h of r.ordered()) {
    const rh = h.rhythm;
    const head = [
      h.id, h.name, h.icon, h.color, rh.type,
      rh.type === 'weekly' ? rh.timesPerWeek : null,
      rh.type === 'days' ? rh.days.join(' ') : null,
      h.targetPerDay, h.reminder, h.createdAt, h.archivedAt,
    ];
    const own = state.checkins.filter((c) => c.habitId === h.id && c.count > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
    if (own.length === 0) rows.push([...head, null, null].map(csvCell).join(','));
    for (const c of own) rows.push([...head, c.date, c.count].map(csvCell).join(','));
  }
  return `${rows.join('\n')}\n`;
}
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') row.push(cell), (cell = '');
    else if (ch === '\n') row.push(cell), rows.push(row), (row = []), (cell = '');
    else cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows;
}
function fromCsv(text: string, now: string): { habits: Habit[]; checkins: CheckIn[] } {
  const [head, ...rows] = parseCsv(text);
  if (head?.join(',') !== CSV_HEAD) throw new Error('not a stackarena CSV');
  const habits = new Map<string, Habit>();
  const checkins: CheckIn[] = [];
  for (const c of rows) {
    if (c.length !== 13) throw new Error('wrong number of columns');
    const [id, name, icon, color, type, times, days, target, reminder, created, archived, date, count] = c as string[];
    if (!habits.has(id!))
      habits.set(id!, {
        id: id!, name: name!, icon: icon!, color: Number(color),
        rhythm: type === 'weekly' ? { type, timesPerWeek: Number(times) }
          : type === 'days' ? { type, days: days!.split(' ').map(Number) } : ({ type } as Habit['rhythm']),
        targetPerDay: Number(target), reminder: reminder || null, archivedAt: archived || null, createdAt: created!,
        updatedAt: now, deviceId: state.deviceId,
      });
    if (date) checkins.push({ habitId: id!, date, count: Number(count), updatedAt: now, deviceId: state.deviceId });
  }
  return { habits: [...habits.values()], checkins };
}

const [command, ...args] = process.argv.slice(2);
const now = new Date().toISOString();
switch (command) {
  case 'login': {
    const session = await request('/auth/login', { email: args[0], password: args[1] });
    state.token = session.token;
    save();
    print({ email: session.user.email });
    break;
  }
  case 'sync': {
    if (!state.token) fail('not logged in');
    const habits = state.habits.filter((h) => state.dirty.includes(h.id));
    const checkins = state.checkins.filter((c) => state.dirty.includes(checkinKey(c)));
    let pulled = 0;
    for (let i = 0; ; i++) {
      const body = await request(
        '/sync',
        {
          deviceId: state.deviceId,
          cursor: state.cursor,
          habits: habits.slice(i * 1000, (i + 1) * 1000),
          checkins: checkins.slice(i * 5000, (i + 1) * 5000),
        },
        state.token,
      );
      for (const h of body.habits) mergeHabit(h);
      for (const c of body.checkins) mergeCheckin(c);
      pulled += body.habits.length + body.checkins.length;
      state.cursor = body.cursor;
      if (!body.hasMore && (i + 1) * 1000 >= habits.length && (i + 1) * 5000 >= checkins.length) break;
    }
    state.dirty = [];
    save();
    print({ pushed: habits.length + checkins.length, pulled });
    break;
  }
  case 'today': {
    const r = rules();
    const due = r.active().filter((h) => r.isDue(h, r.today));
    print({
      today,
      progress: { done: due.filter((h) => r.isDone(h, r.today)).length, due: due.length },
      habits: due.map((h) => ({
        id: h.id, name: h.name, count: r.count(h, r.today), targetPerDay: h.targetPerDay, done: r.isDone(h, r.today),
      })),
    });
    break;
  }
  case 'show': {
    const r = rules();
    print(habitState(r, habitById(args[0])));
    break;
  }
  case 'stats': {
    const r = rules();
    const t = r.today;
    const active = r.active();
    print({
      week: percent(r.rate(active, monday(t), t)),
      month: percent(r.rate(active, r.monthStart(t), t)),
      compare: active.map((h) => ({ id: h.id, rate: percent(r.rate([h], t - 29, t)) })).sort((a, b) => b.rate - a.rate),
    });
    break;
  }
  case 'check': {
    const h = habitById(args[0]);
    const count = Number(args[1]);
    if (!Number.isInteger(count) || count < 0 || count > 99) fail('count must be 0 to 99');
    const c: CheckIn = { habitId: h.id, date: today, count, updatedAt: now, deviceId: state.deviceId };
    putCheckin(c);
    save();
    print(habitState(rules(), h));
    break;
  }
  case 'add':
    writeHabit({
      ...(parseFields(args[0], true) as Habit),
      id: crypto.randomUUID(),
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      deviceId: state.deviceId,
    });
    break;
  case 'edit':
    writeHabit({ ...habitById(args[0]), ...parseFields(args[1], false), updatedAt: now, deviceId: state.deviceId });
    break;
  case 'archive':
    writeHabit({ ...habitById(args[0]), archivedAt: now, updatedAt: now, deviceId: state.deviceId });
    break;
  case 'export': {
    const path = args[0] ?? fail('missing file');
    const r = rules();
    if (path.endsWith('.csv')) writeFileSync(path, toCsv(r));
    else if (path.endsWith('.json'))
      writeFileSync(
        path,
        `${JSON.stringify(
          { format: 'stackarena-habits', version: 1, exportedAt: now, habits: r.ordered(), checkins: state.checkins.filter((c) => c.count > 0) },
          null,
          2,
        )}\n`,
      );
    else fail('file must end in .json or .csv');
    print({ file: path });
    break;
  }
  case 'import': {
    const path = args[0] ?? fail('missing file');
    let data: { habits: Habit[]; checkins: CheckIn[] };
    try {
      const text = readFileSync(path, 'utf8');
      if (path.endsWith('.csv')) data = fromCsv(text, now);
      else {
        data = JSON.parse(text);
        if ((data as any).format !== 'stackarena-habits' || (data as any).version !== 1) throw new Error('not a stackarena export');
      }
      for (const h of data.habits) assertValid('Habit', h);
      for (const c of data.checkins) assertValid('CheckIn', c);
      if (data.checkins.some((c) => !data.habits.some((h) => h.id === c.habitId))) throw new Error('check-in without habit');
    } catch (e) {
      fail(`cannot import ${path}: ${e}`);
    }
    for (const h of data.habits) if (mergeHabit(h)) touch(h.id);
    for (const c of data.checkins) if (mergeCheckin(c)) touch(checkinKey(c));
    save();
    print({ habits: data.habits.length });
    break;
  }
  default:
    fail(`unknown command ${command}; see spec/cli.md`);
}
