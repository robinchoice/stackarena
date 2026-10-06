import { defineConfig } from '@playwright/test';
import { TARGET, TIME_ZONE } from './env';

// TARGET=mockup (default) runs against spec/mockup with seed data and validates the suite itself.
// TARGET=web runs against a team's web client at CLIENT_URL with its backend at BASE_URL.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: '../../results/e2e-artifacts',
  reporter: [['list'], ['json', { outputFile: '../../results/e2e.json' }]],
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  use: {
    testIdAttribute: 'data-testid',
    timezoneId: TIME_ZONE,
    locale: 'en-GB',
    trace: 'retain-on-failure',
  },
  webServer:
    TARGET === 'mockup'
      ? { command: 'bun e2e/serve.ts', cwd: '..', url: 'http://127.0.0.1:4510/spec/mockup/index.html', reuseExistingServer: true }
      : undefined,
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
