// Grades a contest run independently of the agent: the team's last commit, a pristine spec and
// harness from the run's source revision, a fresh database or reference API and no credentials.
// run.ts calls it after every run; to grade a finished run again and update its summary.json:
//   bun orchestrator/grade.ts --run backend-go-1
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

// Installs, build and tests together; start.sh and serve-web.sh install what is missing first
const GRADE_MINUTES = 60;

type Counts = { passed: number; failed: number; skipped: number };
export type Grade = Counts & {
  // Backends are graded with the API suite, clients with the web E2E suite
  suite: 'api' | 'e2e';
  harnessCommit: string;
  started: string;
  minutes: number;
  timedOut: boolean;
  error: string | null;
  // passed / (passed + failed); skipped tests are those the harness itself leaves out for the target
  score: number;
  // Info column for teams with a CLI, not part of the score
  cli: Counts | null;
};

function sh(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const r = Bun.spawnSync(cmd, { ...opts, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`${cmd.slice(0, 4).join(' ')} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

// bun test ends with " 37 pass", " 0 fail" and, if any, " 2 skip"
function bunCounts(log: string): Counts {
  const last = (word: string) => +([...log.matchAll(new RegExp(`^\\s*(\\d+) ${word}\\s*$`, 'gm'))].at(-1)?.[1] ?? 0);
  return { passed: last('pass'), failed: last('fail'), skipped: last('skip') };
}

function playwrightCounts(file: string): Counts {
  const s = JSON.parse(readFileSync(file, 'utf8')).stats;
  return { passed: s.expected + s.flaky, failed: s.unexpected, skipped: s.skipped };
}

const readiness = (url: string, what: string) => `
pid=$!
until curl -sf ${url} >/dev/null; do
  kill -0 $pid 2>/dev/null || { echo '${what} exited before it answered' > /work/grade-logs/error; exit 0; }
  sleep 2
done`;

function script(kind: 'backend' | 'client', folder: string) {
  const setup = `set -u
mkdir -p /work/grade-logs
cd /work/harness && bun install > /work/grade-logs/install.log 2>&1 || { echo 'bun install in harness failed' > /work/grade-logs/error; exit 0; }
cd /work/${folder}`;
  if (kind === 'backend')
    return `${setup}
[ -f start.sh ] || { echo 'no start.sh' > /work/grade-logs/error; exit 0; }
PORT=8080 bash start.sh > /work/grade-logs/server.log 2>&1 &
${readiness('http://localhost:8080/health', 'start.sh')}
cd /work/harness && BASE_URL=http://localhost:8080 bun test api/ > /work/grade-logs/tests.log 2>&1
exit 0`;
  return `${setup}
[ -f serve-web.sh ] || { echo 'no serve-web.sh' > /work/grade-logs/error; exit 0; }
STACKARENA_API_URL=http://api:18080 bash serve-web.sh > /work/grade-logs/server.log 2>&1 &
${readiness('http://localhost:5173/', 'serve-web.sh')}
cd /work/harness
TARGET=web CLIENT_URL=http://localhost:5173 BASE_URL=http://api:18080 bunx playwright test -c e2e/playwright.config.ts > /work/grade-logs/tests.log 2>&1
if [ -f /work/${folder}/cli.sh ]; then
  CLI=/work/${folder}/cli.sh BASE_URL=http://api:18080 bun test cli/ > /work/grade-logs/cli.log 2>&1
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
  for (const f of ['install.log', 'server.log', 'tests.log', 'cli.log'])
    if (existsSync(`${logs}/${f}`)) copyFileSync(`${logs}/${f}`, `${logDir}/${f}`);
  if (existsSync(`${gradeDir}/results/e2e.json`)) copyFileSync(`${gradeDir}/results/e2e.json`, `${logDir}/e2e.json`);
  error ??= timedOut ? `grading exceeded ${GRADE_MINUTES} minutes`
    : existsSync(`${logs}/error`) ? readFileSync(`${logs}/error`, 'utf8').trim() : null;

  const none = { passed: 0, failed: 0, skipped: 0 };
  let counts = none;
  if (kind === 'backend' && existsSync(`${logDir}/tests.log`)) counts = bunCounts(readFileSync(`${logDir}/tests.log`, 'utf8'));
  if (kind === 'client' && existsSync(`${logDir}/e2e.json`)) counts = playwrightCounts(`${logDir}/e2e.json`);
  const cli = existsSync(`${logDir}/cli.log`) ? bunCounts(readFileSync(`${logDir}/cli.log`, 'utf8')) : null;
  rmSync(gradeDir, { recursive: true, force: true });

  const total = counts.passed + counts.failed;
  if (!total) error ??= 'the suite reported no results';
  return {
    suite: kind === 'backend' ? 'api' : 'e2e',
    harnessCommit: o.sourceCommit,
    started: started.toISOString(),
    minutes: Math.round((ended.getTime() - started.getTime()) / 6000) / 10,
    timedOut,
    error,
    ...counts,
    score: total ? Math.round((counts.passed / total) * 1000) / 1000 : 0,
    cli,
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
