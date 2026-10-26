// Grades a contest run independently of the agent: the team's last commit, a pristine spec and
// harness from the run's source revision, a fresh database or reference API and no credentials.
// run.ts calls it after every run; to grade a finished run again and update its summary.json:
//   bun orchestrator/grade.ts --run backend-go-1
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

// Installs, build and tests together; start.sh and serve-web.sh install what is missing first
const GRADE_MINUTES = 60;
// The tools harness/api/contract.sh and harness/load/run.sh take from Docker, pinned for the grading
// container, which has no Docker. A fixed seed gives every backend the same generated requests.
const UV = '0.13.5';
const SCHEMATHESIS = '4.32.5';
const K6 = '2.3.0';
const SEED = 1;

type Counts = { passed: number; failed: number; skipped: number };
// score is passed / (passed + failed); skipped are tests the tool or harness leaves out on purpose
type Part = Counts & { score: number; error: string | null };
export type Grade = {
  harnessCommit: string;
  started: string;
  minutes: number;
  timedOut: boolean;
  error: string | null;
  // Mean of the parts: API suite, contract and load for backends, the web E2E suite for clients
  score: number;
  parts: { api?: Part; contract?: Part & { uniqueFailures: number }; load?: Part & LoadInfo; e2e?: Part };
  // Info column for teams with a CLI, not part of the score
  cli: Counts | null;
};
// Info only: p95 latency per request name and throughput under the load test
type LoadInfo = { p95Ms: Record<string, number>; requestsPerSecond: number };

function sh(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const r = Bun.spawnSync(cmd, { ...opts, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`${cmd.slice(0, 4).join(' ')} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const round = (x: number) => Math.round(x * 1000) / 1000;
function part(counts: Counts, error: string | null = null): Part {
  const total = counts.passed + counts.failed;
  return { ...counts, score: total ? round(counts.passed / total) : 0, error: total ? error : (error ?? 'no results') };
}
const missing = (error: string): Part => ({ passed: 0, failed: 0, skipped: 0, score: 0, error });
const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : null);

// bun test ends with " 37 pass", " 0 fail" and, if any, " 2 skip"
function bunCounts(log: string): Counts {
  const last = (word: string) => +([...log.matchAll(new RegExp(`^\\s*(\\d+) ${word}\\s*$`, 'gm'))].at(-1)?.[1] ?? 0);
  return { passed: last('pass'), failed: last('fail'), skipped: last('skip') };
}

function playwrightPart(json: string): Part {
  const s = JSON.parse(json).stats;
  return part({ passed: s.expected + s.flaky, failed: s.unexpected, skipped: s.skipped });
}

// Schemathesis JSON report: every generated test case either passes all checks or fails one
function contractPart(json: string): Part & { uniqueFailures: number } {
  const r = JSON.parse(json);
  const t = r.test_cases;
  const failed = t.with_failures + t.errored;
  const errors = (r.errors ?? []).length;
  return {
    ...part({ passed: t.generated - failed, failed, skipped: t.without_checks }, errors ? `${errors} operations errored` : null),
    uniqueFailures: t.unique_failures,
  };
}

// k6 summary export: the checks of harness/load/sync.js (status 200 for sync, login and health)
function loadPart(json: string): Part & LoadInfo {
  const m = JSON.parse(json).metrics;
  const p95Ms = Object.fromEntries(
    Object.entries(m)
      .flatMap(([k, v]: [string, any]) => {
        const name = /^http_req_duration\{name:(.+)\}$/.exec(k)?.[1];
        return name ? [[name, Math.round(v['p(95)'] * 10) / 10]] : [];
      }),
  );
  return {
    ...part({ passed: m.checks?.passes ?? 0, failed: m.checks?.fails ?? 0, skipped: 0 }),
    p95Ms,
    requestsPerSecond: Math.round((m.http_reqs?.rate ?? 0) * 10) / 10,
  };
}

const readiness = (url: string, what: string) => `
pid=$!
until curl -sf ${url} >/dev/null; do
  kill -0 $pid 2>/dev/null || { echo '${what} exited before it answered' > $L/error; exit 0; }
  sleep 2
done`;

function script(kind: 'backend' | 'client', folder: string) {
  const setup = `set -uo pipefail
L=/work/grade-logs
mkdir -p $L
cd /work/harness && bun install > $L/install.log 2>&1 || { echo 'bun install in harness failed' > $L/error; exit 0; }
cd /work/${folder}`;
  // Fetched before the team's server starts; a failed download is ours, so it names itself
  const tools = `
fetch() { curl -fsSL --retry 5 --retry-all-errors "$@"; }
fetch https://astral.sh/uv/${UV}/install.sh | sh > $L/tools.log 2>&1 || echo 'uv could not be installed' >> $L/tool-error
fetch https://github.com/grafana/k6/releases/download/v${K6}/k6-v${K6}-linux-amd64.tar.gz | tar -xz -C /tmp >> $L/tools.log 2>&1 ||
  echo 'k6 could not be installed' >> $L/tool-error`;
  if (kind === 'backend')
    return `${setup}
[ -f start.sh ] || { echo 'no start.sh' > $L/error; exit 0; }
${tools}
PORT=8080 bash start.sh > $L/server.log 2>&1 &
${readiness('http://localhost:8080/health', 'start.sh')}
cd /work/harness && BASE_URL=http://localhost:8080 bun test api/ > $L/tests.log 2>&1

# Contract run as in harness/api/contract.sh
token=$(curl -sf -X POST http://localhost:8080/auth/register -H 'content-type: application/json' \\
  -d '{"email":"contract@stackarena.test","password":"correct-horse-battery"}' | jq -r .token)
cd /work/harness/api && ~/.local/bin/uvx schemathesis==${SCHEMATHESIS} run /work/spec/openapi.yaml \\
  --url http://localhost:8080 -H "Authorization: Bearer $token" --exclude-path /auth/logout --checks all \\
  --max-examples 100 --seed ${SEED} --report json --report-json-path $L/contract.json > $L/contract.log 2>&1

# Load test as in harness/load/run.sh
cd /work/harness/load && /tmp/k6-v${K6}-linux-amd64/k6 run --quiet -e BASE_URL=http://localhost:8080 \\
  --summary-export $L/load.json sync.js > $L/load.log 2>&1
exit 0`;
  return `${setup}
[ -f serve-web.sh ] || { echo 'no serve-web.sh' > $L/error; exit 0; }
STACKARENA_API_URL=http://api:18080 bash serve-web.sh > $L/server.log 2>&1 &
${readiness('http://localhost:5173/', 'serve-web.sh')}
cd /work/harness
TARGET=web CLIENT_URL=http://localhost:5173 BASE_URL=http://api:18080 bunx playwright test -c e2e/playwright.config.ts > $L/tests.log 2>&1
if [ -f /work/${folder}/cli.sh ]; then
  CLI=/work/${folder}/cli.sh BASE_URL=http://api:18080 bun test cli/ > $L/cli.log 2>&1
fi
exit 0`;
}

export async function grade(o: {
  repo: string; id: string; team: string; runDir: string; outDir: string; sourceCommit: string; finalCommit: string;
}): Promise<Grade> {
  const [kind, slug] = o.team.split('/') as ['client' | 'backend', string];
  const folder = `${kind}s/${slug}`;
  const gradeDir = `${o.repo}/runs/${o.id}-grade`;
  const logDir = `${o.outDir}/grade`;
  rmSync(gradeDir, { recursive: true, force: true });
  rmSync(logDir, { recursive: true, force: true });
  mkdirSync(gradeDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  // Only what the team committed, next to the spec and harness it was given
  sh(['bash', '-c', `git -C "${o.runDir}" archive ${o.finalCommit} ${folder} | tar -x -C "${gradeDir}"`]);
  sh(['bash', '-c', `git -C "${o.repo}" archive ${o.sourceCommit} spec harness | tar -x -C "${gradeDir}"`]);
  rmSync(`${gradeDir}/harness/reference`, { recursive: true, force: true });
  mkdirSync(`${gradeDir}/${folder}`, { recursive: true });

  const project = `stackarena-${o.id}-grade`;
  const container = `${project}-agent`;
  const { ANTHROPIC_API_KEY: _, CLAUDE_CODE_OAUTH_TOKEN: __, ANTHROPIC_CUSTOM_HEADERS: ___, ...hostEnv } = process.env;
  const env = {
    ...hostEnv, REPO: o.repo, RUN_DIR: gradeDir, OUT_DIR: o.outDir,
    GIT_NAME: 'Stackarena grader', GIT_EMAIL: 'grader@stackarena.test',
  };
  const compose = (...args: string[]) => [
    'docker', 'compose', '-f', `${o.repo}/orchestrator/compose.yaml`, '-p', project, '--profile', kind, ...args,
  ];

  const started = new Date();
  let timedOut = false;
  let error: string | null = null;
  try {
    sh(compose('up', '-d', '--wait', kind === 'backend' ? 'db' : 'api'), { env });
    const timer = setTimeout(() => {
      timedOut = true;
      Bun.spawnSync(['docker', 'stop', '-t', '10', container]);
    }, GRADE_MINUTES * 60_000);
    const out = openSync(`${logDir}/container.log`, 'w');
    await Bun.spawn(compose('run', '--rm', '-T', '--name', container, 'agent', 'bash', '-c', script(kind, folder)), {
      env, stdout: out, stderr: out,
    }).exited;
    clearTimeout(timer);
  } catch (e) {
    error = (e as Error).message;
  } finally {
    Bun.spawnSync(compose('down', '-v'), { env });
  }
  const ended = new Date();

  const logs = `${gradeDir}/grade-logs`;
  for (const f of ['install.log', 'server.log', 'tests.log', 'cli.log', 'tools.log', 'contract.log', 'contract.json', 'load.log', 'load.json'])
    if (existsSync(`${logs}/${f}`)) copyFileSync(`${logs}/${f}`, `${logDir}/${f}`);
  if (existsSync(`${gradeDir}/results/e2e.json`)) copyFileSync(`${gradeDir}/results/e2e.json`, `${logDir}/e2e.json`);
  error ??= timedOut ? `grading exceeded ${GRADE_MINUTES} minutes`
    : read(`${logs}/error`)?.trim() ?? read(`${logs}/tool-error`)?.trim().replaceAll('\n', ', ') ?? null;
  rmSync(gradeDir, { recursive: true, force: true });

  // A part whose report is missing scores zero with the reason: the team's start, or a tool download
  // that failed, which grade.ts --run then repeats
  const report = (file: string) => read(`${logDir}/${file}`);
  const tests = report('tests.log');
  const contract = report('contract.json');
  const load = report('load.json');
  const e2e = report('e2e.json');
  const cliLog = report('cli.log');
  const parts: Grade['parts'] = kind === 'backend'
    ? {
      api: tests ? part(bunCounts(tests)) : missing(error ?? 'no test log'),
      contract: contract ? contractPart(contract) : { ...missing(error ?? 'no contract report'), uniqueFailures: 0 },
      load: load ? loadPart(load) : { ...missing(error ?? 'no load report'), p95Ms: {}, requestsPerSecond: 0 },
    }
    : { e2e: e2e ? playwrightPart(e2e) : missing(error ?? 'no E2E report') };
  const scores = Object.values(parts).map((p) => p.score);

  return {
    harnessCommit: o.sourceCommit,
    started: started.toISOString(),
    minutes: Math.round((ended.getTime() - started.getTime()) / 6000) / 10,
    timedOut,
    error,
    score: round(scores.reduce((a, b) => a + b, 0) / scores.length),
    parts,
    cli: cliLog ? bunCounts(cliLog) : null,
  };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { run: { type: 'string' } } });
  const repo = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  const id = values.run ?? '';
  const outDir = `${repo}/results/runs/${id}`;
  if (!existsSync(`${outDir}/summary.json`)) throw new Error(`--run must name a finished run in results/runs`);
  const summary = JSON.parse(readFileSync(`${outDir}/summary.json`, 'utf8'));
  const result = await grade({
    repo, id, team: summary.team, runDir: `${repo}/runs/${id}`, outDir,
    sourceCommit: summary.sourceCommit, finalCommit: summary.finalCommit,
  });
  const updated = { ...summary, score: result.score, grade: result };
  writeFileSync(`${outDir}/summary.json`, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}
