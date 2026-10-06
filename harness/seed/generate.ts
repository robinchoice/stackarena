// Generates the seed datasets relative to a given today, plus the values every client must show
// for them. Usage: bun seed/generate.ts [--dataset e2e|perf] [--today YYYY-MM-DD] [--tz Europe/Berlin] [--out dir]
import { mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { assertValid } from '../lib/spec';
import {
  type CheckIn,
  type Habit,
  type Rhythm,
  Rules,
  localDate,
  monday,
  percent,
  toDate,
  toDay,
  weekday,
} from './rules';

interface Def {
  name: string;
  icon: string;
  color: number;
  rhythm: Rhythm;
  targetPerDay: number;
  reminder: string | null;
  createdDaysAgo: number;
  archivedDaysAgo?: number;
  rate: number; // chance of a done day in the random history
  force?: number; // done due days (or weeks) right before today, preceded by a miss
  today: number; // today's count
}

const E2E: Def[] = [
  { name: 'Drink water', icon: 'drop', color: 5, rhythm: { type: 'daily' }, targetPerDay: 8, reminder: '09:00', createdDaysAgo: 400, rate: 0.6, force: 12, today: 3 },
  { name: 'Run', icon: 'route', color: 1, rhythm: { type: 'weekly', timesPerWeek: 3 }, targetPerDay: 1, reminder: '07:00', createdDaysAgo: 400, rate: 0.42, force: 4, today: 0 },
  { name: 'Read for 20 minutes', icon: 'book', color: 6, rhythm: { type: 'daily' }, targetPerDay: 1, reminder: '21:30', createdDaysAgo: 400, rate: 0.72, force: 22, today: 1 },
  { name: 'Meditate', icon: 'lotus', color: 7, rhythm: { type: 'daily' }, targetPerDay: 1, reminder: '07:30', createdDaysAgo: 400, rate: 0.6, force: 5, today: 1 },
  { name: 'Phone away after 10 pm', icon: 'moon', color: 4, rhythm: { type: 'daily' }, targetPerDay: 1, reminder: '21:45', createdDaysAgo: 400, rate: 0.5, force: 2, today: 0 },
  { name: 'Take vitamin D', icon: 'sun', color: 3, rhythm: { type: 'daily' }, targetPerDay: 1, reminder: '08:00', createdDaysAgo: 45, rate: 1, today: 1 },
  { name: 'Practice guitar', icon: 'note', color: 2, rhythm: { type: 'days', days: [0, 2, 4] }, targetPerDay: 1, reminder: '18:30', createdDaysAgo: 400, rate: 0.7, force: 9, today: 0 },
  { name: 'Floss', icon: 'leaf', color: 4, rhythm: { type: 'daily' }, targetPerDay: 1, reminder: null, createdDaysAgo: 400, archivedDaysAgo: 60, rate: 0.5, today: 0 },
];

const ICONS = ['drop', 'route', 'book', 'lotus', 'moon', 'sun', 'note', 'leaf', 'dumbbell', 'pen'];
const PERF: Def[] = Array.from({ length: 20 }, (_, k) => {
  const rhythm: Rhythm =
    k % 10 === 4 ? { type: 'days', days: [0, 2, 4] } : k % 10 === 9 ? { type: 'weekly', timesPerWeek: 3 } : { type: 'daily' };
  return {
    name: `Habit ${k + 1}`,
    icon: ICONS[k % ICONS.length]!,
    color: 1 + (k % 7),
    rhythm,
    targetPerDay: [2, 8, 3, 1, 4][k % 5]!,
    reminder: k % 3 === 0 ? null : `${String(6 + (k % 15)).padStart(2, '0')}:${k % 2 ? '30' : '00'}`,
    createdDaysAgo: 3 * 365,
    rate: 0.7 + (k % 4) * 0.08,
    today: k % 4 === 0 ? 1 : 0,
  };
});

// Mulberry32: small deterministic generator, same output on every machine
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uuid = (dataset: string, k: number) =>
  `${dataset === 'e2e' ? 'e2e00000' : 'fe0f0000'}-0000-4000-8000-${String(k + 1).padStart(12, '0')}`;
const at = (day: number, time = '12:00:00') => `${toDate(day)}T${time}.000Z`;

function build(dataset: string, defs: Def[], today: number) {
  const habits: Habit[] = [];
  const checkins: CheckIn[] = [];
  defs.forEach((d, k) => {
    const first = today - d.createdDaysAgo;
    const archived = d.archivedDaysAgo === undefined ? null : today - d.archivedDaysAgo;
    const id = uuid(dataset, k);
    habits.push({
      id,
      name: d.name,
      icon: d.icon,
      color: d.color,
      rhythm: d.rhythm,
      targetPerDay: d.targetPerDay,
      reminder: d.reminder,
      archivedAt: archived === null ? null : at(archived),
      createdAt: at(first),
      updatedAt: at(archived ?? first),
      deviceId: 'seed',
    });

    const random = rng((k + 1) * 7919 + (dataset === 'e2e' ? 0 : 104729));
    const counts = new Map<number, number>();
    const scheduled = (day: number) => d.rhythm.type !== 'days' || d.rhythm.days.includes(weekday(day));
    const last = archived ?? today - 1;
    let prev = true;
    for (let day = first; day <= last; day++) {
      if (!scheduled(day)) continue;
      if (d.rhythm.type === 'weekly') {
        counts.set(day, random() < d.rate ? d.targetPerDay : 0);
        continue;
      }
      const p: number = prev ? Math.min(0.95, d.rate + 0.12) : Math.max(0.08, d.rate - 0.3);
      const done: boolean = d.rate >= 1 || random() < p;
      prev = done;
      const partial = d.targetPerDay > 1 && random() < 0.6 ? 1 + Math.floor(random() * (d.targetPerDay - 1)) : 0;
      counts.set(day, done ? d.targetPerDay : partial);
    }
    if (d.force) {
      if (d.rhythm.type === 'weekly') {
        const mon0 = monday(today);
        for (let w = 1; w <= d.force; w++) {
          const mon = mon0 - 7 * w;
          for (let i = 0; i < 7; i++) counts.set(mon + i, [0, 2, 5].includes(i) ? d.targetPerDay : 0);
        }
        const before = mon0 - 7 * (d.force + 1);
        for (let i = 0; i < 7; i++) counts.set(before + i, i === 3 ? d.targetPerDay : 0);
        for (let day = mon0; day < today; day++) counts.set(day, day === mon0 ? d.targetPerDay : 0);
      } else {
        let day = today - 1;
        for (let n = 0; n < d.force; day--) {
          if (!scheduled(day)) continue;
          counts.set(day, d.targetPerDay);
          n++;
        }
        while (!scheduled(day)) day--;
        counts.set(day, 0);
      }
    }
    if (archived === null && d.today > 0) counts.set(today, d.today);
    for (const [day, count] of [...counts].sort((x, y) => x[0] - y[0])) {
      if (count > 0 && day >= first)
        checkins.push({ habitId: id, date: toDate(day), count, updatedAt: at(day, '20:00:00'), deviceId: 'seed' });
    }
  });
  return { habits, checkins };
}

function expectations(rules: Rules) {
  const t = rules.today;
  const active = rules.active();
  const due = active.filter((h) => rules.isDue(h, t));
  return {
    today: toDate(t),
    progress: { done: due.filter((h) => rules.isDone(h, t)).length, due: due.length },
    habits: Object.fromEntries(
      rules.ordered().map((h) => [
        h.id,
        {
          name: h.name,
          archived: h.archivedAt !== null,
          dueToday: h.archivedAt === null && rules.isDue(h, t),
          countToday: rules.count(h, t),
          doneToday: rules.isDone(h, t),
          currentStreak: rules.currentStreak(h),
          longestStreak: rules.longestStreak(h),
          rate30: percent(rules.rate([h], t - 29, t)),
        },
      ]),
    ),
    stats: {
      week: percent(rules.rate(active, monday(t), t)),
      month: percent(rules.rate(active, rules.monthStart(t), t)),
      compare: active
        .map((h) => ({ id: h.id, rate: percent(rules.rate([h], t - 29, t)) }))
        .sort((a, b) => b.rate - a.rate),
    },
  };
}

const csvCell = (v: string | number | null) => {
  const s = v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

function csv(rules: Rules, checkins: CheckIn[]): string {
  const rows = [
    'habit_id,habit_name,icon,color,rhythm,times_per_week,days,target_per_day,reminder,created_at,archived_at,date,count',
  ];
  for (const h of rules.ordered()) {
    const r = h.rhythm;
    const head = [
      h.id,
      h.name,
      h.icon,
      h.color,
      r.type,
      r.type === 'weekly' ? r.timesPerWeek : null,
      r.type === 'days' ? r.days.join(' ') : null,
      h.targetPerDay,
      h.reminder,
      h.createdAt,
      h.archivedAt,
    ];
    const own = checkins.filter((c) => c.habitId === h.id && c.count > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
    if (own.length === 0) rows.push([...head, null, null].map(csvCell).join(','));
    for (const c of own) rows.push([...head, c.date, c.count].map(csvCell).join(','));
  }
  return `${rows.join('\n')}\n`;
}

const { values } = parseArgs({
  options: {
    dataset: { type: 'string', default: 'e2e' },
    today: { type: 'string' },
    tz: { type: 'string', default: Intl.DateTimeFormat().resolvedOptions().timeZone },
    out: { type: 'string' },
  },
});
const dataset = values.dataset!;
if (dataset !== 'e2e' && dataset !== 'perf') throw new Error('--dataset must be e2e or perf');
const tz = values.tz!;
const today = toDay(values.today ?? localDate(new Date().toISOString(), tz));
const out = values.out ?? new URL(`out/${dataset}`, import.meta.url).pathname;

const { habits, checkins } = build(dataset, dataset === 'e2e' ? E2E : PERF, today);
for (const h of habits) assertValid('Habit', h);
for (const c of checkins) assertValid('CheckIn', c);
const rules = new Rules(habits, checkins, today, tz);

await mkdir(out, { recursive: true });
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
await Bun.write(`${out}/dataset.json`, json({ format: 'stackarena-seed', dataset, today: toDate(today), timeZone: tz, habits, checkins }));
await Bun.write(`${out}/expected.json`, json(expectations(rules)));
await Bun.write(
  `${out}/export.json`,
  json({ format: 'stackarena-habits', version: 1, exportedAt: at(today, '16:00:00'), habits, checkins }),
);
await Bun.write(`${out}/export.csv`, csv(rules, checkins));
console.log(`${dataset}: ${habits.length} habits, ${checkins.length} check-ins, today ${toDate(today)} → ${out}`);
