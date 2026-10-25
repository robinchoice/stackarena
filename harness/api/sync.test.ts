import { describe, expect, test } from 'bun:test';
import { checkin, habit, pullAll, pushAll, register, sync } from './client';

const later = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

describe('sync', () => {
  test('a new account starts empty', async () => {
    const { token } = await register('empty');
    const res = await sync(token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hasMore: false, habits: [], checkins: [] });
    expect(typeof res.body.cursor).toBe('string');
  });

  test('pushed records come back and reach a second device', async () => {
    const { token } = await register('roundtrip');
    const h = habit({ rhythm: { type: 'days', days: [0, 2, 4] }, reminder: '07:30' });
    const c = checkin(h.id, { count: 1 });
    const res = await sync(token, { deviceId: 'phone', habits: [h], checkins: [c] });
    expect(res.status).toBe(200);
    expect(res.body.habits).toEqual([h]);
    expect(res.body.checkins).toEqual([c]);

    const other = await pullAll(token, 'laptop');
    expect(other.habits).toEqual([h]);
    expect(other.checkins).toEqual([c]);
  });

  test('the cursor returns only later changes', async () => {
    const { token } = await register('cursor');
    const h = habit();
    const first = await sync(token, { habits: [h] });
    const empty = await sync(token, { cursor: first.body.cursor });
    expect(empty.body.habits).toEqual([]);
    expect(empty.body.checkins).toEqual([]);

    const c = checkin(h.id);
    await sync(token, { deviceId: 'phone', checkins: [c] });
    const delta = await sync(token, { deviceId: 'laptop', cursor: empty.body.cursor });
    expect(delta.body.habits).toEqual([]);
    expect(delta.body.checkins).toEqual([c]);
  });

  test('an unknown cursor returns everything', async () => {
    const { token } = await register('badcursor');
    const h = habit();
    await sync(token, { habits: [h] });
    const res = await sync(token, { deviceId: 'laptop', cursor: 'definitely-not-a-cursor' });
    expect(res.status).toBe(200);
    expect(res.body.habits).toEqual([h]);
  });

  test('last write wins per check-in, ties go to the larger deviceId', async () => {
    const { token } = await register('lww');
    const h = habit();
    const t0 = '2026-10-01T10:00:00.000Z';
    await sync(token, { habits: [h], checkins: [checkin(h.id, { count: 3, updatedAt: t0, deviceId: 'b' })] });

    await sync(token, { checkins: [checkin(h.id, { count: 1, updatedAt: later(t0, -60_000), deviceId: 'z' })] });
    expect((await pullAll(token)).checkins[0]).toMatchObject({ count: 3, deviceId: 'b' });

    await sync(token, { checkins: [checkin(h.id, { count: 5, updatedAt: t0, deviceId: 'a' })] });
    expect((await pullAll(token)).checkins[0]).toMatchObject({ count: 3, deviceId: 'b' });

    await sync(token, { checkins: [checkin(h.id, { count: 6, updatedAt: t0, deviceId: 'c' })] });
    expect((await pullAll(token)).checkins[0]).toMatchObject({ count: 6, deviceId: 'c' });

    await sync(token, { checkins: [checkin(h.id, { count: 0, updatedAt: later(t0, 1), deviceId: 'a' })] });
    const all = await pullAll(token);
    expect(all.checkins).toHaveLength(1);
    expect(all.checkins[0]).toMatchObject({ count: 0, deviceId: 'a' });
  });

  test('timestamps compare as instants, not as strings', async () => {
    const { token } = await register('instant');
    const h = habit();
    await sync(token, { habits: [h], checkins: [checkin(h.id, { count: 2, updatedAt: '2026-10-01T10:00:00.000Z', deviceId: 'a' })] });
    // 11:30+02:00 is 09:30Z, earlier than 10:00Z although the string sorts later
    await sync(token, { checkins: [checkin(h.id, { count: 7, updatedAt: '2026-10-01T11:30:00.000+02:00', deviceId: 'b' })] });
    expect((await pullAll(token)).checkins[0]).toMatchObject({ count: 2 });
  });

  test('last write wins for habits, archiving travels as a field', async () => {
    const { token } = await register('habitlww');
    const h = habit({ updatedAt: '2026-10-01T10:00:00.000Z' });
    await sync(token, { habits: [h] });
    const archived = { ...h, archivedAt: '2026-10-02T08:00:00.000Z', updatedAt: '2026-10-02T08:00:00.000Z', deviceId: 'phone' };
    const stale = { ...h, name: 'Stale rename', updatedAt: '2026-10-01T12:00:00.000Z', deviceId: 'laptop' };
    await sync(token, { deviceId: 'phone', habits: [archived] });
    await sync(token, { deviceId: 'laptop', habits: [stale] });
    expect((await pullAll(token)).habits).toEqual([archived]);
  });

  test('a push with an unknown habit changes nothing', async () => {
    const { token } = await register('atomic');
    const h = habit();
    const res = await sync(token, { habits: [h], checkins: [checkin(h.id), checkin(crypto.randomUUID())] });
    expect(res.status).toBe(422);
    const all = await pullAll(token);
    expect(all.habits).toEqual([]);
    expect(all.checkins).toEqual([]);
  });

  test.each([
    ['count above 99', (id: string) => ({ checkins: [checkin(id, { count: 100 })] })],
    ['negative count', (id: string) => ({ checkins: [checkin(id, { count: -1 })] })],
    ['bad date', (id: string) => ({ checkins: [checkin(id, { date: '2026-13-01' })] })],
    ['empty weekday list', () => ({ habits: [habit({ rhythm: { type: 'days', days: [] } })] })],
    ['weekly without times', () => ({ habits: [habit({ rhythm: { type: 'weekly' } as never })] })],
    ['reminder 24:00', () => ({ habits: [habit({ reminder: '24:00' })] })],
    ['color 8', () => ({ habits: [habit({ color: 8 })] })],
    ['unknown icon', () => ({ habits: [habit({ icon: 'rocket' })] })],
    ['empty name', () => ({ habits: [habit({ name: '' })] })],
    ['bad device id', () => ({ deviceId: 'has space' })],
  ])('rejects %s with 422', async (_, make) => {
    const { token } = await register('invalid');
    const h = habit();
    await sync(token, { habits: [h] });
    expect((await sync(token, make(h.id))).status).toBe(422);
  });

  test('accounts are isolated, the same habit id can exist in two accounts', async () => {
    const a = await register('iso-a');
    const b = await register('iso-b');
    const h = habit();
    await sync(a.token, { habits: [h], checkins: [checkin(h.id, { count: 1 })] });
    expect((await pullAll(b.token)).habits).toEqual([]);

    const copy = { ...h, name: 'Imported copy' };
    expect((await sync(b.token, { habits: [copy], checkins: [checkin(h.id, { count: 4 })] })).status).toBe(200);
    expect((await pullAll(a.token)).habits[0]!.name).toBe(h.name);
    expect((await pullAll(b.token)).checkins[0]!.count).toBe(4);
  });

  test('large histories come back in pages of at most 5000 records', async () => {
    const { token } = await register('pages');
    const habits = Array.from({ length: 4 }, (_, k) => habit({ name: `Habit ${k}` }));
    const checkins = habits.flatMap((h) =>
      Array.from({ length: 3000 }, (_, d) => checkin(h.id, { date: new Date(Date.UTC(2018, 0, 1) + d * 864e5).toISOString().slice(0, 10) })),
    );
    await pushAll(token, habits, checkins);

    const all = await pullAll(token);
    expect(all.pages).toBeGreaterThanOrEqual(3);
    expect(all.habits).toHaveLength(4);
    expect(all.checkins).toHaveLength(12_000);
    expect(new Set(all.checkins.map((c) => `${c.habitId}|${c.date}`)).size).toBe(12_000);
  }, 120_000);

  test('a push above the limits is rejected', async () => {
    const { token } = await register('limits');
    const h = habit();
    await sync(token, { habits: [h] });
    const tooMany = Array.from({ length: 5001 }, (_, d) =>
      checkin(h.id, { date: new Date(Date.UTC(2010, 0, 1) + d * 864e5).toISOString().slice(0, 10) }),
    );
    expect((await sync(token, { checkins: tooMany })).status).toBe(422);
  }, 60_000);
});
