import { toDay, weekday } from '../seed/rules';
import { expect, test } from './fixtures';

const habitIdOf = (testId: string) => testId.split('.')[2]!;

test('a new habit on specific days appears on Today with its stepper', async ({ ui, expected }) => {
  const today = weekday(toDay(expected.today));
  const other = (today + 3) % 7;
  await ui.tap('habit.new');
  await ui.fill('form.name', 'Stretch');
  await ui.tap('form.icon.dumbbell');
  await expect(ui.el('form.icon.dumbbell')).toHaveAttribute('aria-pressed', 'true');
  await ui.tap('form.color.6');
  await ui.tap('form.rhythm.days');
  // The form may preselect days; end up with exactly today and one other day
  for (let d = 0; d < 7; d++) {
    const want = d === today || d === other;
    if ((await ui.pressed(`form.day.${d}`)) !== want) await ui.tap(`form.day.${d}`);
  }
  await ui.tap('form.target.inc');
  await ui.tap('form.save');

  await ui.tap('nav.today');
  const names = await ui.ids(/^today\.habit\.[0-9a-f-]{36}\.name$/);
  let id = '';
  for (const n of names) if ((await ui.text(n)) === 'Stretch') id = habitIdOf(n);
  expect(id, 'new habit on Today').not.toBe('');
  await expect(ui.el(`today.habit.${id}.count`)).toHaveText('0');
  expect(await ui.number('today.progress.due')).toBe(expected.progress.due + 1);
});

test('renaming a habit shows the new name everywhere', async ({ ui, expected }) => {
  const [id] = Object.entries(expected.habits).find(([, h]) => !h.archived)!;
  await ui.tap('nav.habits');
  await ui.tap(`habits.${id}.edit`);
  await ui.fill('form.name', 'Renamed habit');
  await ui.tap('form.save');
  await expect(ui.el(`habits.${id}.name`)).toHaveText('Renamed habit');
  await ui.tap('nav.today');
  await expect(ui.el(`today.habit.${id}.name`)).toHaveText('Renamed habit');
});

test('cancel leaves a habit unchanged', async ({ ui, expected }) => {
  const [id, h] = Object.entries(expected.habits).find(([, x]) => !x.archived)!;
  await ui.tap('nav.habits');
  await ui.tap(`habits.${id}.edit`);
  await ui.fill('form.name', 'Not saved');
  await ui.tap('form.cancel');
  await expect(ui.el(`habits.${id}.name`)).toHaveText(h.name);
});

test('archiving hides a habit until it is restored', async ({ ui, expected }) => {
  const [id] = Object.entries(expected.habits).find(([, h]) => h.dueToday)!;
  await ui.tap('nav.habits');
  await ui.tap(`habits.${id}.edit`);
  await ui.tap('form.archive');
  await ui.tap('nav.today');
  await expect(ui.el(`today.habit.${id}`)).toHaveCount(0);
  expect(await ui.number('today.progress.due')).toBe(expected.progress.due - 1);

  await ui.tap('nav.habits');
  await ui.tap(`habits.${id}.restore`);
  await ui.tap('nav.today');
  await expect(ui.el(`today.habit.${id}`)).toBeVisible();
  expect(await ui.number('today.progress.due')).toBe(expected.progress.due);
});

test('archived habits from the seed are listed for restore', async ({ ui, expected }) => {
  await ui.tap('nav.habits');
  for (const [id, h] of Object.entries(expected.habits)) {
    if (!h.archived) continue;
    await expect(ui.el(`habits.${id}.restore`)).toBeVisible();
    await expect(ui.el(`habits.${id}.edit`)).toHaveCount(0);
  }
});
