// Reference implementation of spec/rules.md. Days are integers (days since 1970-01-01), so no
// time zone is involved once dates are local calendar dates.

export type Rhythm =
  | { type: 'daily' }
  | { type: 'weekly'; timesPerWeek: number }
  | { type: 'days'; days: number[] };

export interface Habit {
  id: string;
  name: string;
  icon: string;
  color: number;
  rhythm: Rhythm;
  targetPerDay: number;
  reminder: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deviceId: string;
}

export interface CheckIn {
  habitId: string;
  date: string;
  count: number;
  updatedAt: string;
  deviceId: string;
}

export const toDay = (date: string) =>
  Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / 864e5;
export const toDate = (day: number) => new Date(day * 864e5).toISOString().slice(0, 10);
// 1970-01-01 was a Thursday, weekday 3 with Monday as 0
export const weekday = (day: number) => (((day + 3) % 7) + 7) % 7;
export const monday = (day: number) => day - weekday(day);

export function localDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(iso),
  );
}

export class Rules {
  private counts = new Map<string, Map<number, number>>();
  private start = new Map<string, number>();

  constructor(
    readonly habits: Habit[],
    checkins: CheckIn[],
    readonly today: number,
    timeZone: string,
  ) {
    for (const h of habits) {
      this.counts.set(h.id, new Map());
      this.start.set(h.id, toDay(localDate(h.createdAt, timeZone)));
    }
    for (const c of checkins) this.counts.get(c.habitId)?.set(toDay(c.date), c.count);
  }

  ordered(): Habit[] {
    return [...this.habits].sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
  }

  active(): Habit[] {
    return this.ordered().filter((h) => h.archivedAt === null);
  }

  firstDay(h: Habit): number {
    return this.start.get(h.id)!;
  }

  count(h: Habit, day: number): number {
    return this.counts.get(h.id)!.get(day) ?? 0;
  }

  isDone(h: Habit, day: number): boolean {
    return this.count(h, day) >= h.targetPerDay;
  }

  doneDaysInWeek(h: Habit, mon: number, except?: number): number {
    let n = 0;
    for (let d = mon; d < mon + 7 && d <= this.today; d++) if (d !== except && this.isDone(h, d)) n++;
    return n;
  }

  isDue(h: Habit, day: number): boolean {
    if (day < this.firstDay(h)) return false;
    const r = h.rhythm;
    if (r.type === 'daily') return true;
    if (r.type === 'days') return r.days.includes(weekday(day));
    return this.doneDaysInWeek(h, monday(day), day) < r.timesPerWeek;
  }

  currentStreak(h: Habit): number {
    const r = h.rhythm;
    if (r.type === 'weekly') {
      let mon = monday(this.today);
      if (this.doneDaysInWeek(h, mon) < r.timesPerWeek) mon -= 7;
      let n = 0;
      for (; mon + 6 >= this.firstDay(h); mon -= 7) {
        if (this.doneDaysInWeek(h, mon) >= r.timesPerWeek) n++;
        else break;
      }
      return n;
    }
    let day = this.isDone(h, this.today) ? this.today : this.today - 1;
    let n = 0;
    for (; day >= this.firstDay(h); day--) {
      if (!this.isDue(h, day)) continue;
      if (this.isDone(h, day)) n++;
      else break;
    }
    return n;
  }

  longestStreak(h: Habit): number {
    const r = h.rhythm;
    let best = 0;
    let run = 0;
    if (r.type === 'weekly') {
      const current = monday(this.today);
      for (let mon = monday(this.firstDay(h)); mon <= current; mon += 7) {
        if (this.doneDaysInWeek(h, mon) >= r.timesPerWeek) best = Math.max(best, ++run);
        else if (mon !== current) run = 0;
      }
    } else {
      for (let day = this.firstDay(h); day <= this.today; day++) {
        if (!this.isDue(h, day)) continue;
        if (this.isDone(h, day)) best = Math.max(best, ++run);
        else if (day !== this.today) run = 0;
      }
    }
    return Math.max(best, this.currentStreak(h));
  }

  // Contribution and due units of one habit for the days a to b
  units(h: Habit, a: number, b: number): { done: number; due: number } {
    a = Math.max(a, this.firstDay(h));
    b = Math.min(b, this.today);
    if (b < a) return { done: 0, due: 0 };
    const r = h.rhythm;
    if (r.type === 'weekly') {
      let doneDays = 0;
      for (let d = a; d <= b; d++) if (this.isDone(h, d)) doneDays++;
      const expected = (r.timesPerWeek * (b - a + 1)) / 7;
      return { done: Math.min(doneDays, expected), due: expected };
    }
    let done = 0;
    let due = 0;
    for (let d = a; d <= b; d++) {
      if (!this.isDue(h, d)) continue;
      due++;
      done += Math.min(1, this.count(h, d) / h.targetPerDay);
    }
    return { done, due };
  }

  rate(habits: Habit[], a: number, b: number): number {
    let done = 0;
    let due = 0;
    for (const h of habits) {
      const u = this.units(h, a, b);
      done += u.done;
      due += u.due;
    }
    return due ? done / due : 0;
  }

  monthStart(day: number): number {
    const d = toDate(day);
    return toDay(`${d.slice(0, 8)}01`);
  }
}

export const percent = (rate: number) => Math.floor(rate * 100 + 0.5);
