// The fixed questions of the decompilation column. Every answer is checkable against spec/, and
// every score is computed from the agent's JSON answer alone, never by another agent.
export type Question = { id: string; ask: string; score: (answer: unknown) => number };

const asArray = (a: unknown) => (Array.isArray(a) ? a.map((v) => String(v).trim()) : []);
const asObject = (a: unknown) => (a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : {});
const share = (checks: boolean[]) => checks.filter(Boolean).length / checks.length;

// spec/openapi.yaml
const SPEC_PATHS = ['/health', '/auth/register', '/auth/login', '/auth/logout', '/me', '/sync'];
// Every client signs in and writes through /sync, so these three must show up
const CORE_PATHS = ['/auth/register', '/auth/login', '/sync'];
// spec/mockup/index.html, German labels
const GERMAN = ['Heute', 'Statistik', 'Gewohnheiten', 'Einstellungen', 'Heute nicht fällig', 'Noch keine Serie'];

export function questions(apiUrl: string): Question[] {
  return [
    {
      id: 'api_base_url',
      ask: `Which backend base URL did the build get at build time? Answer the exact string.`,
      score: (a) => (typeof a === 'string' && a.includes(apiUrl) ? 1 : 0),
    },
    {
      id: 'api_paths',
      ask: `Which HTTP paths of the backend does the app call? Answer an array of paths without the base URL, for example ["/foo/bar"].`,
      score: (a) => {
        const paths = asArray(a).map((p) => p.replace(/\?.*$/, '').replace(/\/$/, '') || '/');
        const found = share(CORE_PATHS.map((p) => paths.includes(p)));
        const invented = paths.filter((p) => !SPEC_PATHS.includes(p)).length;
        return Math.max(0, found - invented / SPEC_PATHS.length);
      },
    },
    {
      id: 'streak',
      ask: `How does the app compute the current streak? Answer an object: {"startsYesterdayWhenTodayNotDone": true|false, "skipsDaysThatAreNotDue": true|false, "weeklyRhythmCountsIn": "days"|"weeks"|"times"}.`,
      score: (a) => {
        const o = asObject(a);
        return share([
          o.startsYesterdayWhenTodayNotDone === true,
          o.skipsDaysThatAreNotDue === true,
          o.weeklyRhythmCountsIn === 'weeks',
        ]);
      },
    },
    {
      id: 'rate_rounding',
      ask: `How does the app turn a completion rate into the percentage it shows? Answer an object: {"mode": "half_up"|"half_down"|"half_even"|"floor"|"ceil", "decimals": <number of decimal places>}.`,
      score: (a) => {
        const o = asObject(a);
        return share([o.mode === 'half_up', Number(o.decimals) === 0]);
      },
    },
    {
      id: 'heatmap',
      ask: `How is the history heatmap built? Answer an object: {"weekColumns": <number of week columns>, "levels": <number of fill steps for a day with check-ins>, "thresholds": [<share of the daily target where the fill changes>, ...]}.`,
      score: (a) => {
        const o = asObject(a);
        const thresholds = asArray(o.thresholds)
          .map(Number)
          .filter((n) => Number.isFinite(n))
          .sort((x, y) => x - y);
        return share([
          Number(o.weekColumns) === 53,
          Number(o.levels) === 4,
          JSON.stringify(thresholds) === JSON.stringify([0.3, 0.6, 1]),
        ]);
      },
    },
    {
      id: 'german',
      ask: `Which German interface texts does the build contain? Answer an array of the exact strings, at most 40.`,
      score: (a) => {
        const texts = asArray(a);
        return share(GERMAN.map((g) => texts.includes(g)));
      },
    },
  ];
}
