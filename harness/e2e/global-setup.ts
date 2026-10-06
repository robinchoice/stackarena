import { execFileSync } from 'node:child_process';
import { TIME_ZONE } from './env';

// Fresh e2e seed for today in the browser's time zone, so expectations match what the client shows
export default function globalSetup() {
  // TODAY=YYYY-MM-DD pins the date; only the mockup honours it, real clients use the device date
  const today = process.env.TODAY ? ['--today', process.env.TODAY] : [];
  execFileSync('bun', ['seed/generate.ts', '--dataset', 'e2e', '--tz', TIME_ZONE, ...today], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: 'inherit',
  });
}
