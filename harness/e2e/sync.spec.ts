import { readFileSync } from 'node:fs';
import { pullAll } from '../api/client';
import { assertValid } from '../lib/spec';
import { SEED_DIR } from './env';
import { UI, expect, onlyReal, test } from './fixtures';

// These scenarios need a real client and backend. They are validated with the first team's build.
test.beforeEach(onlyReal);

test('a check-in made offline reaches the server after reconnecting', async ({ ui, page, user, expected }) => {
  const [id] = Object.entries(expected.habits).find(([, h]) => h.dueToday && !h.doneToday)!;
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

test('a second device sees a check-in after syncing', async ({ ui, browser, user, expected }) => {
  const [id] = Object.entries(expected.habits).find(([, h]) => h.dueToday && !h.doneToday)!;
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
  expect(data.habits.map((h: { id: string }) => h.id).sort()).toEqual(seed.habits.map((h) => h.id).sort());
  expect(data.checkins.filter((c: { count: number }) => c.count > 0)).toHaveLength(seed.checkins.length);
});

test('the CSV export has one row per check-in', async ({ ui, page, seed }) => {
  await ui.tap('nav.settings');
  const download = page.waitForEvent('download');
  await ui.tap('settings.export.csv');
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^habits-\d{4}-\d{2}-\d{2}\.csv$/);
  const lines = readFileSync((await file.path())!, 'utf8').trimEnd().split('\n');
  expect(lines[0]).toBe(readFileSync(`${SEED_DIR}export.csv`, 'utf8').split('\n')[0]);
  expect(lines.length - 1).toBe(seed.checkins.length);
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
