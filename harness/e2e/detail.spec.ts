import { expect, test } from './fixtures';

test('details show streaks and the 30-day rate of every active habit', async ({ ui, expected }) => {
  for (const [id, h] of Object.entries(expected.habits)) {
    if (h.archived) continue;
    await ui.tap(`today.habit.${id}.open`);
    await expect(ui.el('detail.name')).toHaveText(h.name);
    expect.soft(await ui.number('detail.streak.current'), `${h.name}: current streak`).toBe(h.currentStreak);
    expect.soft(await ui.number('detail.streak.longest'), `${h.name}: longest streak`).toBe(h.longestStreak);
    expect.soft(await ui.number('detail.rate30'), `${h.name}: 30-day rate`).toBe(h.rate30);
    await expect(ui.el('detail.heatmap')).toBeVisible();
    await expect(ui.el('detail.chart')).toBeVisible();
    await ui.toToday();
  }
});

test('counting in the details changes Today as well', async ({ ui, expected, seed }) => {
  const h = seed.habits.find((x) => x.targetPerDay > 1 && expected.habits[x.id]!.dueToday)!;
  const start = expected.habits[h.id]!.countToday;
  await ui.tap(`today.habit.${h.id}.open`);
  await ui.tap('detail.today.inc');
  await expect(ui.el('detail.today.count')).toHaveText(String(start + 1));
  await ui.toToday();
  await expect(ui.el(`today.habit.${h.id}.count`)).toHaveText(String(start + 1));
});

test('the chart switches between weeks and months', async ({ ui, expected }) => {
  const [id] = Object.entries(expected.habits).find(([, h]) => !h.archived)!;
  await ui.tap(`today.habit.${id}.open`);
  await ui.tap('detail.range.month');
  await expect(ui.el('detail.range.month')).toHaveAttribute('aria-selected', 'true');
  await ui.tap('detail.range.week');
  await expect(ui.el('detail.range.week')).toHaveAttribute('aria-selected', 'true');
});
