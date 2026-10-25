// Checks a team's CLI after spec/cli.md against the rule reference and a backend.
//   CLI=<path to cli.sh> BASE_URL=<backend url> bun test cli/
import { beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { BASE_URL, PASSWORD, pullAll, pushAll, register } from '../api/client';
import { assertValid } from '../lib/spec';
import type { CheckIn, Habit } from '../seed/rules';

const CLI = process.env.CLI;
if (!CLI) throw new Error('CLI must point to the cli.sh of a team');
setDefaultTimeout(60_000);

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const work = mkdtempSync(`${tmpdir()}/stackarena-cli-`);
execFileSync('bun', ['seed/generate.ts', '--dataset', 'e2e', '--tz', TZ, '--out', `${work}/seed`], {
  cwd: new URL('..', import.meta.url).pathname,
  stdio: 'ignore',
});
const read = (name: string) => readFileSync(`${work}/seed/${name}`, 'utf8');
const seed: { habits: Habit[]; checkins: CheckIn[] } = JSON.parse(read('dataset.json'));
const expected = JSON.parse(read('expected.json'));
const due = Object.entries<any>(expected.habits).filter(([, h]) => h.dueToday);

// One device: its own local data, talking to BASE_URL unless told otherwise
class Device {
  readonly home = mkdtempSync(`${work}/device-`);
  run(args: string[], api = BASE_URL) {
    return execFileSync(CLI!, args, {
      env: { ...process.env, STACKARENA_HOME: this.home, STACKARENA_API_URL: api, TZ },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  json(...args: string[]) {
    return JSON.parse(this.run(args));
  }
  fails(args: string[], api = BASE_URL) {
    expect(() => this.run(args, api)).toThrow();
  }
}
const OFFLINE = 'http://127.0.0.1:9';

async function seeded() {
  const user = await register('cli');
  await pushAll(user.token, seed.habits, seed.checkins);
  const device = new Device();
  device.run(['login', user.email, PASSWORD]);
  device.run(['sync']);
  return { user, device };
}
async function fresh() {
  const user = await register('cli');
  const device = new Device();
  device.run(['login', user.email, PASSWORD]);
  return { user, device };
}
const byKey = <T extends { habitId?: string; id?: string; date?: string }>(list: T[]) =>
  [...list].sort((a, b) => ((a.id ?? `${a.habitId}/${a.date}`) < (b.id ?? `${b.habitId}/${b.date}`) ? -1 : 1));
const newHabit = {
  name: 'Stretch',
  icon: 'leaf',
  color: 2,
  rhythm: { type: 'daily' },
  targetPerDay: 1,
  reminder: '07:15',
};

describe('rules on synced data', () => {
  let device: Device;
  beforeAll(async () => ({ device } = await seeded()));

  test('today lists the due habits with the progress', () => {
    const today = device.json('today');
    expect(today.today).toBe(expected.today);
    expect(today.progress).toEqual(expected.progress);
    expect(today.habits.map((h: any) => h.id)).toEqual(due.map(([id]) => id));
    for (const h of today.habits) {
      const e = expected.habits[h.id];
      expect(h).toEqual({
        id: h.id,
        name: e.name,
        count: e.countToday,
        targetPerDay: seed.habits.find((x) => x.id === h.id)!.targetPerDay,
        done: e.doneToday,
      });
    }
  });

  test('show gives streaks, rate and due state of every habit', () => {
    for (const [id, e] of Object.entries(expected.habits)) expect(device.json('show', id)).toEqual({ id, ...(e as object) });
  });

  test('stats gives week, month and the comparison', () => {
    expect(device.json('stats')).toEqual(expected.stats);
  });

  test('export writes the data as JSON and CSV', () => {
    device.run(['export', `${device.home}-out.json`]);
    const file = JSON.parse(readFileSync(`${device.home}-out.json`, 'utf8'));
    expect(file.format).toBe('stackarena-habits');
    expect(file.version).toBe(1);
    expect(byKey(file.habits)).toEqual(byKey(seed.habits));
    expect(byKey(file.checkins.filter((c: CheckIn) => c.count > 0))).toEqual(byKey(seed.checkins.filter((c) => c.count > 0)));

    device.run(['export', `${device.home}-out.csv`]);
    expect(readFileSync(`${device.home}-out.csv`, 'utf8')).toBe(read('export.csv'));
  });
});

test('check sets the count for today and sync brings it to the server', async () => {
  const { user, device } = await seeded();
  const [id] = due.find(([, h]) => h.countToday === 0)!;
  const target = seed.habits.find((h) => h.id === id)!.targetPerDay;

  const state = device.json('check', id, String(target));
  expect(state).toMatchObject({ id, countToday: target, doneToday: true });
  expect(device.json('today').progress).toEqual({ ...expected.progress, done: expected.progress.done + 1 });

  device.run(['sync']);
  const onServer = (await pullAll(user.token)).checkins.find((c) => c.habitId === id && c.date === expected.today);
  expect(onServer?.count).toBe(target);
});

test('changes made offline reach the server once it is back', async () => {
  const { user, device } = await seeded();
  const [id] = due.find(([, h]) => h.countToday === 0)!;

  device.run(['check', id, '1'], OFFLINE);
  expect(device.json('show', id).countToday).toBe(1);
  device.fails(['sync'], OFFLINE);
  const count = async () =>
    (await pullAll(user.token)).checkins.find((c) => c.habitId === id && c.date === expected.today)?.count ?? 0;
  expect(await count()).toBe(expected.habits[id].countToday);

  device.run(['sync']);
  expect(await count()).toBe(1);
});

test('add, edit and archive change today and the habit', async () => {
  const { device } = await fresh();
  const added = device.json('add', JSON.stringify(newHabit));
  assertValid('Habit', added);
  expect(added).toMatchObject({ ...newHabit, archivedAt: null });
  expect(device.json('today').habits.map((h: any) => h.id)).toEqual([added.id]);

  const edited = device.json('edit', added.id, JSON.stringify({ name: 'Stretch twice', targetPerDay: 2 }));
  expect(edited).toMatchObject({ id: added.id, name: 'Stretch twice', targetPerDay: 2, icon: 'leaf' });
  expect(Date.parse(edited.updatedAt)).toBeGreaterThanOrEqual(Date.parse(added.updatedAt));

  const archived = device.json('archive', added.id);
  expect(archived.archivedAt).not.toBeNull();
  expect(device.json('today')).toMatchObject({ progress: { done: 0, due: 0 }, habits: [] });
  expect(device.json('show', added.id)).toMatchObject({ archived: true, dueToday: false });
  device.fails(['edit', added.id, '{"name":""}']);
});

test('a second device gets new habits and the later edit wins', async () => {
  const { user, device: a } = await fresh();
  const added = a.json('add', JSON.stringify(newHabit));
  a.run(['sync']);

  const b = new Device();
  b.run(['login', user.email, PASSWORD]);
  b.run(['sync']);
  expect(b.json('show', added.id).name).toBe('Stretch');

  b.json('edit', added.id, JSON.stringify({ name: 'Earlier' }));
  await Bun.sleep(20);
  a.json('edit', added.id, JSON.stringify({ name: 'Later' }));
  a.run(['sync']);
  b.run(['sync']);
  a.run(['sync']);
  expect(a.json('show', added.id).name).toBe('Later');
  expect(b.json('show', added.id).name).toBe('Later');
});

test('a JSON import restores a backup and reaches the server', async () => {
  const { user, device } = await fresh();
  writeFileSync(`${device.home}-in.json`, read('export.json'));
  expect(device.json('import', `${device.home}-in.json`)).toEqual({ habits: seed.habits.length });
  expect(device.json('stats')).toEqual(expected.stats);

  device.run(['sync']);
  const server = await pullAll(user.token);
  expect(server.habits).toHaveLength(seed.habits.length);
  expect(server.checkins.filter((c) => c.count > 0)).toHaveLength(seed.checkins.filter((c) => c.count > 0).length);
});

test('a CSV import restores habits and check-ins', async () => {
  const { device } = await fresh();
  writeFileSync(`${device.home}-in.csv`, read('export.csv'));
  expect(device.json('import', `${device.home}-in.csv`)).toEqual({ habits: seed.habits.length });
  expect(device.json('stats')).toEqual(expected.stats);
  for (const [id, e] of Object.entries(expected.habits)) expect(device.json('show', id)).toEqual({ id, ...(e as object) });
});

test('a broken file changes nothing', async () => {
  const { device } = await fresh();
  device.json('add', JSON.stringify(newHabit));
  const before = device.json('today');
  writeFileSync(`${device.home}-bad.json`, '{"format":"stackarena-habits","version":1,"habits":[{"id":"x"}],"checkins":[]}');
  device.fails(['import', `${device.home}-bad.json`]);
  writeFileSync(`${device.home}-bad.csv`, 'not,a,backup\n1,2,3\n');
  device.fails(['import', `${device.home}-bad.csv`]);
  expect(device.json('today')).toEqual(before);
});
