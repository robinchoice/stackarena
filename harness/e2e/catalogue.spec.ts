import { readFileSync } from 'node:fs';
import { TARGET } from './env';
import { expect, test } from './fixtures';

// Walks through every screen of the mockup and checks that spec/test-ids.json lists exactly the
// ids the mockup uses. Runs against the mockup only, it guards the catalogue, not a client.
const catalogue = Object.keys(
  JSON.parse(readFileSync(new URL('../../spec/test-ids.json', import.meta.url), 'utf8')).ids,
);
const normalise = (id: string) =>
  id
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, '<habitId>')
    .replace(/^form\.icon\.\w+$/, 'form.icon.<icon>')
    .replace(/^form\.color\.\d$/, 'form.color.<stage>')
    .replace(/^form\.day\.\d$/, 'form.day.<weekday>');

test('the mockup uses exactly the ids from spec/test-ids.json', async ({ ui, seed, isMobile }) => {
  test.skip(TARGET !== 'mockup', 'checks the mockup only');
  const seen = new Set<string>();
  const collect = async () => (await ui.ids(/./)).forEach((id) => seen.add(normalise(id)));
  const weekly = seed.habits.find((h) => h.rhythm.type === 'weekly')!;
  const days = seed.habits.find((h) => h.rhythm.type === 'days')!;
  const multi = seed.habits.find((h) => h.targetPerDay > 1)!;

  await collect();
  await ui.tap(`today.habit.${multi.id}.open`);
  await collect();
  await ui.tap('detail.today.inc');
  await ui.toToday();
  const single = seed.habits.find((h) => h.targetPerDay === 1 && h.archivedAt === null && h.rhythm.type === 'daily')!;
  await ui.tap(`today.habit.${single.id}.open`);
  await collect();
  await ui.toToday();
  await ui.tap('nav.stats');
  await collect();
  await ui.tap('nav.habits');
  await collect();
  for (const h of [weekly, days]) {
    await ui.tap(`habits.${h.id}.edit`);
    await collect();
    await ui.tap('form.cancel');
    if (isMobile) await ui.tap('nav.habits');
  }
  await ui.tap('habit.new');
  await collect();
  await ui.tap('form.cancel');
  await ui.tap('nav.settings');
  await ui.tap('settings.sync');
  await collect();
  await ui.tap('settings.logout');
  await collect();

  const extra = [...seen].filter((id) => !catalogue.includes(id));
  expect(extra, 'ids missing from spec/test-ids.json').toEqual([]);
  if (isMobile) {
    const missing = catalogue.filter((id) => !seen.has(id));
    expect(missing, 'catalogue ids the mockup never shows').toEqual([]);
  }
});
