import { expect, test } from './fixtures';

test('Today shows the due habits and the progress', async ({ ui, expected }) => {
  expect(await ui.number('today.progress.done')).toBe(expected.progress.done);
  expect(await ui.number('today.progress.due')).toBe(expected.progress.due);
  for (const [id, h] of Object.entries(expected.habits)) {
    const row = ui.el(`today.habit.${id}`);
    if (h.archived) {
      await expect(row).toHaveCount(0);
      continue;
    }
    await expect(ui.el(`today.habit.${id}.name`)).toHaveText(h.name);
    const control = ui.el(`today.habit.${id}.check`).or(ui.el(`today.habit.${id}.inc`));
    if (h.dueToday) await expect(control).toBeVisible();
    else await expect(control).toHaveCount(0);
  }
});

test('the check button toggles a habit done for today', async ({ ui, expected }) => {
  const [id] = Object.entries(expected.habits).find(([, h]) => h.dueToday && h.doneToday)!;
  const done = expected.progress.done;
  const check = `today.habit.${id}.check`;
  expect(await ui.pressed(check)).toBe(true);

  await ui.tap(check);
  await expect(ui.el(check)).toHaveAttribute('aria-pressed', 'false');
  expect(await ui.number('today.progress.done')).toBe(done - 1);

  await ui.tap(check);
  await expect(ui.el(check)).toHaveAttribute('aria-pressed', 'true');
  expect(await ui.number('today.progress.done')).toBe(done);
});

test('the stepper counts within 0 and 99', async ({ ui, expected, seed }) => {
  const h = seed.habits.find((x) => x.targetPerDay > 1 && x.archivedAt === null && expected.habits[x.id]!.dueToday)!;
  const id = `today.habit.${h.id}`;
  const start = expected.habits[h.id]!.countToday;
  await expect(ui.el(`${id}.count`)).toHaveText(String(start));

  await ui.tap(`${id}.inc`);
  await expect(ui.el(`${id}.count`)).toHaveText(String(start + 1));
  for (let i = 0; i <= start; i++) await ui.tap(`${id}.dec`);
  await expect(ui.el(`${id}.count`)).toHaveText('0');
  await expect(ui.el(`${id}.dec`)).toBeDisabled();

  for (let i = 0; i < h.targetPerDay; i++) await ui.tap(`${id}.inc`);
  expect(await ui.number('today.progress.done')).toBe(expected.progress.done + 1);
});
