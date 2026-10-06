import { readFileSync } from 'node:fs';
import { type Locator, type Page, test as base, expect } from '@playwright/test';
import { PASSWORD, pushAll, register } from '../api/client';
import type { CheckIn, Habit } from '../seed/rules';
import { CLIENT_URL, MOCKUP_URL, SEED_DIR, TARGET } from './env';

export interface Expected {
  today: string;
  progress: { done: number; due: number };
  habits: Record<
    string,
    {
      name: string;
      archived: boolean;
      dueToday: boolean;
      countToday: number;
      doneToday: boolean;
      currentStreak: number;
      longestStreak: number;
      rate30: number;
    }
  >;
  stats: { week: number; month: number; compare: { id: string; rate: number }[] };
}

export interface Seed {
  today: string;
  timeZone: string;
  habits: Habit[];
  checkins: CheckIn[];
}

const read = <T>(file: string): T => JSON.parse(readFileSync(SEED_DIR + file, 'utf8'));

// Test ids are the only selectors the suite uses, so the same steps can later drive native apps.
export class UI {
  constructor(
    readonly page: Page,
    readonly phone: boolean,
  ) {}
  el(id: string): Locator {
    return this.page.getByTestId(id);
  }
  tap(id: string) {
    return this.el(id).click();
  }
  fill(id: string, value: string) {
    return this.el(id).fill(value);
  }
  async text(id: string) {
    return (await this.el(id).innerText()).trim();
  }
  async number(id: string) {
    return Number.parseInt((await this.text(id)).replace(/[^\d-]/g, ''), 10);
  }
  async pressed(id: string) {
    return (await this.el(id).getAttribute('aria-pressed')) === 'true';
  }
  // Ids of all elements whose id matches the pattern, in display order
  async ids(pattern: RegExp) {
    const all = await this.page.locator('[data-testid]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!));
    return all.filter((id) => pattern.test(id));
  }
  async toToday() {
    if (this.phone && (await this.el('detail.back').isVisible())) await this.tap('detail.back');
    else await this.tap('nav.today');
    await expect(this.el('today.progress.due')).toBeVisible();
  }
}

export const test = base.extend<{ seed: Seed; expected: Expected; ui: UI; user: { email: string; token: string } | null }>({
  seed: async ({}, use) => use(read<Seed>('dataset.json')),
  expected: async ({}, use) => use(read<Expected>('expected.json')),
  user: async ({ seed }, use) => {
    if (TARGET === 'mockup') return use(null);
    const user = await register('e2e');
    await pushAll(user.token, seed.habits, seed.checkins);
    await use(user);
  },
  ui: async ({ page, isMobile, user }, use) => {
    const ui = new UI(page, isMobile);
    if (TARGET === 'mockup') {
      await page.goto(`${MOCKUP_URL}?app=${isMobile ? 'phone' : 'desktop'}&lang=en&data=/harness/seed/out/e2e/dataset.json`);
    } else {
      await page.goto(CLIENT_URL);
      await ui.fill('login.email', user!.email);
      await ui.fill('login.password', PASSWORD);
      await ui.tap('login.submit');
    }
    await expect(ui.el('today.progress.due')).toBeVisible();
    await use(ui);
  },
});

export { expect };
export const onlyReal = () => test.skip(TARGET === 'mockup', 'needs a real client and backend');
