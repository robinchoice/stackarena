import { readFileSync } from 'node:fs';
import { pullAll } from '../api/client';
import { assertValid } from '../lib/spec';
import { SEED_DIR } from './env';
import { type Expected, type Seed, UI, expect, onlyReal, test } from './fixtures';

function csvRows(text: string): string[][] {
  const rows: string[][] = [[]];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\n')) {
      rows.at(-1)!.push(cell);
      cell = '';
      if (char === '\n') rows.push([]);
    } else {
      if (!quoted && char === '\r') throw new Error('CSV must use LF line endings');
      cell += char;
    }
  }
  expect(quoted, 'closed CSV field').toBe(false);
  if (cell || rows.at(-1)!.length) rows.at(-1)!.push(cell);
  else rows.pop();
  return rows.map((row, index) => index === 0 ? row : row.map((cell, column) =>
    cell && (column === 9 || column === 10) ? new Date(cell).toISOString() : cell,
  ));
}

// A habit with the check button (targetPerDay 1) that is due today and not done yet
const checkable = (seed: Seed, expected: Expected) =>
  Object.entries(expected.habits).find(
    ([id, h]) => h.dueToday && !h.doneToday && seed.habits.find((s) => s.id === id)!.targetPerDay === 1,
  )![0];

// These scenarios need a real client and backend. They are validated with the first team's build.
test.beforeEach(onlyReal);

test('a check-in made offline reaches the server after reconnecting', async ({ ui, page, user, expected, seed }) => {
  const id = checkable(seed, expected);
  const check = `today.habit.${id}.check`;
  const onServer = async () =>
    (await pullAll(user!.token)).checkins.find((c) => c.habitId === id && c.date === expected.today)?.count ?? 0;

  await page.context().setOffline(true);
  await ui.tap(check);
  await expect(ui.el(check)).toHaveAttribute('aria-pressed', 'true');
  expect(await onServer()).toBe(0);

  await page.context().setOffline(false);
  await expect.poll(onServer, { timeout: 30_000 }).toBe(1);
});

test('a second device sees a check-in after syncing', async ({ ui, browser, user, expected, seed }) => {
  const id = checkable(seed, expected);
  await ui.tap(`today.habit.${id}.check`);
  await ui.tap('sync.status');

  const second = await browser.newPage();
  await second.goto(ui.page.url());
  const other = new UI(second, ui.phone);
  if (await other.el('login.email').isVisible()) {
    await other.fill('login.email', user!.email);
    await other.fill('login.password', 'correct-horse-battery');
    await other.tap('login.submit');
  }
  await other.tap('sync.status');
  await expect(other.el(`today.habit.${id}.check`)).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
});

test('the JSON export holds every habit and check-in', async ({ ui, page, seed }) => {
  await ui.tap('nav.settings');
  const download = page.waitForEvent('download');
  await ui.tap('settings.export.json');
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^habits-\d{4}-\d{2}-\d{2}\.json$/);
  const data = JSON.parse(readFileSync((await file.path())!, 'utf8'));
  expect(data).toMatchObject({ format: 'stackarena-habits', version: 1 });
  for (const h of data.habits) assertValid('Habit', h);
  for (const c of data.checkins) assertValid('CheckIn', c);
  const habits = (items: typeof seed.habits) => items.map((h) => ({
    ...h, createdAt: Date.parse(h.createdAt), updatedAt: Date.parse(h.updatedAt),
    archivedAt: h.archivedAt === null ? null : Date.parse(h.archivedAt),
  })).sort((a, b) => a.id.localeCompare(b.id));
  const checkins = (items: typeof seed.checkins) => items.filter((c) => c.count > 0).map((c) => ({
    ...c, updatedAt: Date.parse(c.updatedAt),
  })).sort((a, b) => a.habitId.localeCompare(b.habitId) || a.date.localeCompare(b.date));
  expect(habits(data.habits)).toEqual(habits(seed.habits));
  expect(checkins(data.checkins)).toEqual(checkins(seed.checkins));
});

test('the CSV export preserves every field', async ({ ui, page }) => {
  await ui.tap('nav.settings');
  const download = page.waitForEvent('download');
  await ui.tap('settings.export.csv');
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^habits-\d{4}-\d{2}-\d{2}\.csv$/);
  const actual = csvRows(readFileSync((await file.path())!, 'utf8'));
  const expected = csvRows(readFileSync(`${SEED_DIR}export.csv`, 'utf8'));
  expect(actual).toEqual(expected);
});

test('importing a CSV export restores its habits', async ({ ui, page }) => {
  await ui.tap('nav.settings');
  const chooser = page.waitForEvent('filechooser');
  await ui.tap('settings.import');
  const csv = readFileSync(`${SEED_DIR}export.csv`, 'utf8').replaceAll('e2e00000-', 'c5f00000-');
  await (await chooser).setFiles({ name: 'habits.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(ui.el('toast')).toBeVisible();
  await ui.tap('nav.habits');
  await expect(ui.el('habits.c5f00000-0000-4000-8000-000000000001.name')).toBeVisible();
});
