import { expect, test } from './fixtures';

test('Statistics show the rate of the current week and month', async ({ ui, expected }) => {
  await ui.tap('nav.stats');
  await ui.tap('stats.range.week');
  expect(await ui.number('stats.rate')).toBe(expected.stats.week);
  await ui.tap('stats.range.month');
  await expect(ui.el('stats.range.month')).toHaveAttribute('aria-selected', 'true');
  expect(await ui.number('stats.rate')).toBe(expected.stats.month);
  await expect(ui.el('stats.chart.rate')).toBeVisible();
});

test('the comparison lists every active habit, highest rate first', async ({ ui, expected }) => {
  await ui.tap('nav.stats');
  await expect(ui.el('stats.chart.compare')).toBeVisible();
  const shown = await ui.ids(/^stats\.compare\.[0-9a-f-]{36}$/);
  expect(shown.map((s) => s.slice('stats.compare.'.length)).sort()).toEqual(expected.stats.compare.map((c) => c.id).sort());

  const rates: number[] = [];
  for (const s of shown) rates.push(await ui.number(s));
  const want = Object.fromEntries(expected.stats.compare.map((c) => [c.id, c.rate]));
  shown.forEach((s, k) => expect.soft(rates[k], s).toBe(want[s.slice('stats.compare.'.length)]));
  expect(rates).toEqual([...rates].sort((a, b) => b - a));
});
