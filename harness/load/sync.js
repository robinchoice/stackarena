// k6 load test for discipline 12. Run with load/run.sh. It reports latencies and throughput per
// request name; scoring reads them from the summary, so there are no pass/fail thresholds here.
import http from 'k6/http';
import { check } from 'k6';

const BASE = (__ENV.BASE_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const PASSWORD = 'correct-horse-battery';
const USERS = 20;
const HABITS = 5;
const DAYS = 365;
const headers = (token) => ({
  'content-type': 'application/json',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});

export const options = {
  setupTimeout: '120s',
  summaryTrendStats: ['avg', 'p(50)', 'p(95)', 'p(99)', 'max'],
  // Empty thresholds only make k6 report each request name on its own
  thresholds: Object.fromEntries(
    ['sync-delta', 'sync-full', 'login', 'health'].map((n) => [`http_req_duration{name:${n}}`, []]),
  ),
  scenarios: {
    sync: {
      executor: 'ramping-vus',
      exec: 'syncLoop',
      stages: [
        { duration: '10s', target: 20 },
        { duration: '30s', target: 50 },
        { duration: '10s', target: 0 },
      ],
    },
    login: { executor: 'constant-arrival-rate', exec: 'login', rate: 5, timeUnit: '1s', duration: '50s', preAllocatedVUs: 10, maxVUs: 50 },
    health: { executor: 'constant-arrival-rate', exec: 'health', rate: 50, timeUnit: '1s', duration: '50s', preAllocatedVUs: 10, maxVUs: 50 },
  },
};

const uuid = (u, h) => `10ad0000-0000-4000-8000-${String(u * 100 + h).padStart(12, '0')}`;
const day = (offset) => new Date(Date.now() - offset * 864e5).toISOString().slice(0, 10);

export function setup() {
  const run = Date.now().toString(36);
  const users = [];
  for (let u = 0; u < USERS; u++) {
    const email = `load-${run}-${u}@stackarena.test`;
    const res = http.post(`${BASE}/auth/register`, JSON.stringify({ email, password: PASSWORD }), { headers: headers() });
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${res.body}`);
    const token = res.json('token');
    const now = new Date().toISOString();
    const habits = [];
    const checkins = [];
    for (let h = 0; h < HABITS; h++) {
      const id = uuid(u, h);
      habits.push({ id, name: `Load ${h}`, icon: 'drop', color: 1 + h, rhythm: { type: 'daily' }, targetPerDay: 1, reminder: null, archivedAt: null, createdAt: now, updatedAt: now, deviceId: 'seed' });
      for (let d = 1; d <= DAYS; d++) checkins.push({ habitId: id, date: day(d), count: 1, updatedAt: now, deviceId: 'seed' });
    }
    const seeded = http.post(`${BASE}/sync`, JSON.stringify({ deviceId: 'seed', cursor: null, habits, checkins }), { headers: headers(token) });
    if (seeded.status !== 200) throw new Error(`seed failed: ${seeded.status}`);
    users.push({ email, token });
  }
  return { users };
}

let cursor = null;
let iteration = 0;

export function syncLoop(data) {
  const u = (__VU - 1) % USERS;
  const { token } = data.users[u];
  const now = new Date().toISOString();
  const checkins = [];
  for (let k = 0; k < 1 + (iteration % 5); k++) {
    checkins.push({ habitId: uuid(u, (iteration + k) % HABITS), date: day(k % 3), count: 1 + (iteration % 3), updatedAt: now, deviceId: `vu-${__VU}` });
  }
  const full = iteration % 20 === 0;
  const res = http.post(
    `${BASE}/sync`,
    JSON.stringify({ deviceId: `vu-${__VU}`, cursor: full ? null : cursor, habits: [], checkins }),
    { headers: headers(token), tags: { name: full ? 'sync-full' : 'sync-delta' } },
  );
  check(res, { 'sync 200': (r) => r.status === 200 });
  if (res.status === 200) cursor = res.json('cursor');
  iteration++;
}

export function login(data) {
  const { email } = data.users[(__ITER + __VU) % USERS];
  const res = http.post(`${BASE}/auth/login`, JSON.stringify({ email, password: PASSWORD }), {
    headers: headers(),
    tags: { name: 'login' },
  });
  check(res, { 'login 200': (r) => r.status === 200 });
}

export function health() {
  check(http.get(`${BASE}/health`, { tags: { name: 'health' } }), { 'health 200': (r) => r.status === 200 });
}
