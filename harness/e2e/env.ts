export const TARGET = (process.env.TARGET ?? 'mockup') as 'mockup' | 'web';
export const TIME_ZONE = process.env.TIME_ZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
export const MOCKUP_URL = 'http://127.0.0.1:4510/spec/mockup/index.html';
export const CLIENT_URL = process.env.CLIENT_URL ?? 'http://127.0.0.1:5173';
export const SEED_DIR = new URL('../seed/out/e2e/', import.meta.url).pathname;
