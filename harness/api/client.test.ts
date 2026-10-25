import { afterEach, expect, test } from 'bun:test';
import { checkin, habit, pullAll } from './client';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('pullAll accepts smaller pages and follows the returned cursor', async () => {
  const h = habit();
  const c = checkin(h.id);
  const cursors: (string | null)[] = [];
  globalThis.fetch = (async (_, init) => {
    cursors.push(JSON.parse(init!.body as string).cursor);
    return Response.json(cursors.length === 1
      ? { habits: [h], checkins: [], cursor: 'next', hasMore: true }
      : { habits: [], checkins: [c], cursor: 'done', hasMore: false });
  }) as typeof fetch;
  expect(await pullAll('fixture-token')).toEqual({ habits: [h], checkins: [c], cursor: 'done', pages: 2 });
  expect(cursors).toEqual([null, 'next']);
});

test('pullAll rejects a response whose combined record count exceeds the contract', async () => {
  const h = habit();
  const records = Array.from({ length: 5000 }, (_, i) => checkin(h.id, {
    date: new Date(Date.UTC(2000, 0, 1) + i * 864e5).toISOString().slice(0, 10),
  }));
  globalThis.fetch = (async () => Response.json({ habits: [h], checkins: records, cursor: 'done', hasMore: false })) as unknown as typeof fetch;
  await expect(pullAll('fixture-token')).rejects.toThrow('sync response exceeds 5000 records');
});
