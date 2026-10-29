import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(mode: string, api = false) {
  const root = mkdtempSync(join(tmpdir(), 'stackarena-test-'));
  roots.push(root);
  mkdirSync(`${root}/orchestrator`, { recursive: true });
  mkdirSync(`${root}/bin`);
  mkdirSync(`${root}/dev`);
  for (const file of ['run.ts', 'grade.ts', 'night.ts', 'decompile.ts', 'usage.ts', 'questions.ts', 'teams.json', 'prompt.md', 'pack.md', 'decompile.md']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    writeFileSync(`${root}/orchestrator/${file}`, source.replace("from 'node:os'", "from '../os.ts'"));
  }
  writeFileSync(`${root}/os.ts`, `export const homedir = () => process.env.STACKARENA_FIXTURE;`);
  writeFileSync(`${root}/.secrets`, `export CLAUDE_STACKARENA_TOKEN=fixture-token\n${api ? 'export ANTHROPIC_STACKARENA_API_KEY=fixture-key\n' : ''}`);
  writeFileSync(`${root}/preload.ts`, `const interval = globalThis.setInterval;
globalThis.setInterval = ((fn, ms, ...args) => interval(fn, process.env.STACKARENA_MODE === 'budget-complete' ? ms : Math.min(ms, 50), ...args)) as typeof setInterval;
if (process.env.STACKARENA_MODE === 'night-retry') {
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...args: any[]) { super(args.length ? args[0] : '2026-10-25T01:30:00'); }
  } as DateConstructor;
  Bun.sleepSync = () => {};
}
`);
  writeFileSync(`${root}/bin/systemd-run`, `#!${process.execPath}
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const root = process.env.STACKARENA_FIXTURE;
const count = existsSync(root + '/starts') ? +readFileSync(root + '/starts', 'utf8') : 0;
writeFileSync(root + '/starts', String(count + 1));
mkdirSync(root + '/runs/backend-bun-1', { recursive: true });
mkdirSync(root + '/results/runs/backend-bun-1/session', { recursive: true });
`, { mode: 0o755 });
  writeFileSync(`${root}/bin/systemctl`, `#!${process.execPath}
import { readFileSync } from 'node:fs';
if (process.argv.includes('is-active')) process.exit(+readFileSync(process.env.STACKARENA_FIXTURE + '/starts', 'utf8') >= 2 ? 0 : 1);
`, { mode: 0o755 });
  writeFileSync(`${root}/bin/git`, `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), root = process.env.STACKARENA_FIXTURE;
if (args.includes('archive')) {
  writeFileSync(root + '/archived', args[args.indexOf('archive') + 1]);
  const tar = Bun.spawnSync(['/usr/bin/tar', '-cf', '-', '--files-from', '/dev/null']);
  process.stdout.write(tar.stdout);
} else if (args.includes('--show-toplevel')) console.log(process.env.STACKARENA_MODE === 'foreign-toplevel' ? root : process.cwd());
else if (args.includes('clean')) writeFileSync(root + '/cleaned', process.cwd());
else if (args.includes('rev-parse')) {
  if (args.includes('-C')) {
    let count = 0;
    try { count = +readFileSync(root + '/revision-reads', 'utf8'); } catch {}
    writeFileSync(root + '/revision-reads', String(count + 1));
    console.log(count ? 'b'.repeat(40) : 'a'.repeat(40));
  } else console.log('c'.repeat(40));
} else if (args.includes('rev-list')) console.log('0');
`, { mode: 0o755 });
  writeFileSync(`${root}/bin/docker`, `#!${process.execPath}
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), root = process.env.STACKARENA_FIXTURE, mode = process.env.STACKARENA_MODE;
const action = args[0] === 'compose' ? (args.includes('up') ? 'up' : args.includes('down') ? 'down' : 'run') : args[0] === 'network' ? 'network-' + args[1] : args[0];
appendFileSync(root + '/calls', action + '\\n');
if (action === 'up' && mode === 'up-fails') process.exit(1);
if (action === 'stop' || action === 'rm') {
  try { process.kill(+readFileSync(root + '/' + args.at(-1) + '.pid', 'utf8'), 'SIGTERM'); } catch {}
  process.exit(0);
}
if (action !== 'run') process.exit(0);
const name = args[args.indexOf('--name') + 1];
writeFileSync(root + '/' + name + '.pid', String(process.pid));
if (name.endsWith('-grade-agent')) {
  const logs = process.env.RUN_DIR + '/grade-logs';
  mkdirSync(logs, { recursive: true });
  writeFileSync(root + '/grade-credentials', String(!!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN)));
  if (mode === 'grade-client') {
    mkdirSync(process.env.RUN_DIR + '/results', { recursive: true });
    writeFileSync(process.env.RUN_DIR + '/results/e2e.json', JSON.stringify({ stats: { expected: 19, flaky: 1, unexpected: 4, skipped: 3 } }));
    writeFileSync(logs + '/cli.log', ' 12 pass\\n 1 fail\\n');
    process.exit(0);
  }
  if (mode === 'grade-no-start') writeFileSync(logs + '/error', 'no start.sh\\n');
  else {
    writeFileSync(logs + '/tests.log', '(pass) a\\n 30 pass\\n 2 fail\\n 1 skip\\n');
    writeFileSync(logs + '/contract.json', JSON.stringify({ test_cases: { generated: 100, with_failures: 10, errored: 0, without_checks: 2, unique_failures: 3 }, errors: [] }));
    if (mode === 'grade-tool-error') {
      writeFileSync(logs + '/tool-error', 'k6 could not be installed\\n');
      process.exit(0);
    }
    writeFileSync(logs + '/load.json', JSON.stringify({ metrics: {
      checks: { passes: 990, fails: 10 }, http_reqs: { rate: 123.45 }, 'http_req_duration{name:login}': { 'p(95)': 12.34 },
    } }));
  }
  process.exit(0);
}
const mounts = args.flatMap((x, i) => x === '-v' ? [args[i + 1]] : []);
const out = mounts.find(x => x.endsWith(':/out'))?.slice(0, -5);
const session = mounts.find(x => x.endsWith(':/home/agent/.claude/projects/-work'))?.split(':')[0] ?? process.env.OUT_DIR + '/session';
if (name.endsWith('-pack')) {
  mkdirSync(out + '/web', { recursive: true });
  writeFileSync(out + '/web/index.html', 'fixture');
  writeFileSync(out + '/pack.json', mode === 'bad-pack' ? '{' : JSON.stringify({ web: { built: mode !== 'not-built' } }));
} else if (out) writeFileSync(out + '/report.json', mode === 'bad-report' ? '{"answers":' : JSON.stringify({ answers: {} }));
const resumed = args.includes('--resume');
const fallback = mode.startsWith('fallback');
const freshFallback = mode === 'fallback-no-session';
const apiAttempt = args.some(x => x.startsWith('ANTHROPIC_API_KEY='));
if (freshFallback && apiAttempt) {
  console.log(JSON.stringify({ type: 'result', is_error: true, api_error_status: 400, session_id: 'fixture-session', subtype: 'error' }));
  process.exit(1);
}
if (freshFallback && resumed) process.exit(1);
const input = name.endsWith('-pack') ? 0 : mode === 'budget' || mode === 'budget-complete' ? 1500000 : mode === 'fallback-budget' ? 700000 : 100000;
appendFileSync(session + '/fixture-session.jsonl', JSON.stringify({ type: 'assistant', message: { id: resumed ? 'second' : 'first', usage: { input_tokens: input } } }) + '\\n');
if (!name.endsWith('-pack') && (mode === 'budget' || (mode === 'fallback-budget' && resumed))) await Bun.sleep(1000);
console.log(JSON.stringify(fallback && !freshFallback && !resumed && !name.endsWith('-pack')
  ? { type: 'result', is_error: true, api_error_status: 429, session_id: 'fixture-session', subtype: 'error' }
  : { type: 'result', subtype: 'success' }));
`, { mode: 0o755 });
  return {
    root,
    run(script: string, args: string[]) {
      return Bun.spawnSync([process.execPath, '--preload', `${root}/preload.ts`, `${root}/orchestrator/${script}`, ...args], {
        env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, STACKARENA_FIXTURE: root, STACKARENA_MODE: mode },
        stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
      });
    },
    calls: () => readFileSync(`${root}/calls`, 'utf8').trim().split('\n'),
  };
}

test('a failed compose setup is torn down', () => {
  const f = fixture('up-fails');
  const result = f.run('run.ts', ['--team', 'backend/bun', '--smoke']);
  expect(result.exitCode).not.toBe(0);
  expect(f.calls()).toEqual(['up', 'down']);
  expect(readFileSync(`${f.root}/cleaned`, 'utf8')).toBe(realpathSync(`${f.root}/runs/smoke-backend-bun-1`));
});

test('the first failed night start is archived before its retry', () => {
  const f = fixture('night-retry');
  const result = f.run('night.ts', []);
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
  expect(readFileSync(`${f.root}/starts`, 'utf8')).toBe('2');
  expect(result.stdout.toString()).toContain('started backend-bun-1');
});

function nightWithThread(inputAt: string) {
  const f = fixture('night-retry');
  const id = '70bc99ff-e461-4e48-984e-b161ab5a84c2';
  mkdirSync(`${f.root}/.claude/projects/-home-dev-kontor`, { recursive: true });
  writeFileSync(`${f.root}/.claude/projects/-home-dev-kontor/${id}.jsonl`, '{}\n');
  mkdirSync(`${f.root}/dev/kontor/.savor/threads/t1`, { recursive: true });
  writeFileSync(`${f.root}/dev/kontor/.savor/threads/t1/thread.json`, JSON.stringify({ inputAt, agentSessions: [{ provider: 'claude', sessionId: id }] }));
  return f.run('night.ts', []);
}

test('a busy Savor thread without recent input does not hold the night run back', () => {
  const result = nightWithThread('2026-10-25T00:30:00');
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain('started backend-bun-1');
});

test('a busy Savor thread with recent input holds the night run back', () => {
  const result = nightWithThread('2026-10-25T01:20:00');
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain('no run: agent session active');
});

test('the recorded source revision is the archived revision', () => {
  const f = fixture('success');
  const result = f.run('run.ts', ['--team', 'backend/bun', '--smoke']);
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
  const summary = JSON.parse(readFileSync(`${f.root}/results/runs/smoke-backend-bun-1/summary.json`, 'utf8'));
  expect(summary.sourceCommit).toBe(readFileSync(`${f.root}/archived`, 'utf8'));
  expect(f.calls().at(-1)).toBe('down');
});

function graded(mode: string, team = 'backend/bun') {
  const f = fixture(mode, true);
  const result = f.run('run.ts', ['--team', team, '--smoke']);
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
  const id = `smoke-${team.replace('/', '-')}-1`;
  return { ...f, summary: JSON.parse(readFileSync(`${f.root}/results/runs/${id}/summary.json`, 'utf8')) };
}

test('a run is graded on a fresh setup without credentials', () => {
  const f = graded('success');
  expect(f.calls()).toEqual(['up', 'run', 'down', 'up', 'run', 'down']);
  expect(readFileSync(`${f.root}/grade-credentials`, 'utf8')).toBe('false');
  expect(f.summary.score).toBe(0.943);
  expect(f.summary.grade).toMatchObject({ error: null, harnessCommit: f.summary.sourceCommit, parts: {
    api: { passed: 30, failed: 2, skipped: 1, score: 0.938, error: null },
    contract: { passed: 90, failed: 10, skipped: 2, score: 0.9, uniqueFailures: 3 },
    load: { passed: 990, failed: 10, score: 0.99, p95Ms: { login: 12.3 }, requestsPerSecond: 123.5 },
  } });
  expect(existsSync(`${f.root}/runs/smoke-backend-bun-1-grade`)).toBe(false);
  expect(readFileSync(`${f.root}/cleaned`, 'utf8')).toBe(realpathSync(`${f.root}/runs/smoke-backend-bun-1`));
});

test('ignored files are only removed in the run repository itself', () => {
  const f = fixture('foreign-toplevel');
  const result = f.run('run.ts', ['--team', 'backend/bun', '--smoke']);
  expect(result.exitCode).toBe(0);
  expect(existsSync(`${f.root}/cleaned`)).toBe(false);
});

test('a client is scored by its web E2E run, its CLI only as info', () => {
  const f = graded('grade-client', 'client/rust-core');
  expect(f.summary.score).toBe(0.833);
  expect(f.summary.grade).toMatchObject({ error: null, parts: { e2e: { passed: 20, failed: 4, skipped: 3, score: 0.833 } }, cli: { passed: 12, failed: 1, skipped: 0 } });
  expect(Object.keys(f.summary.grade.parts)).toEqual(['e2e']);
});

test('a tool that could not be fetched names itself instead of blaming the team', () => {
  const f = graded('grade-tool-error');
  expect(f.summary.grade).toMatchObject({ error: 'k6 could not be installed', parts: {
    api: { score: 0.938, error: null }, contract: { score: 0.9 }, load: { score: 0, error: 'k6 could not be installed' },
  } });
});

test('a team that cannot be started scores zero with the reason', () => {
  const f = graded('grade-no-start');
  expect(f.summary.score).toBe(0);
  expect(f.summary.grade).toMatchObject({ error: 'no start.sh', parts: {
    api: { score: 0, error: 'no start.sh' }, contract: { score: 0, error: 'no start.sh' }, load: { score: 0, error: 'no start.sh' },
  } });
});

function decompile(mode: string, api = false) {
  const f = fixture(mode, api);
  mkdirSync(`${f.root}/results/runs/client-dart-1`, { recursive: true });
  writeFileSync(`${f.root}/results/runs/client-dart-1/summary.json`, JSON.stringify({ team: 'client/dart' }));
  const result = f.run('decompile.ts', ['--run', 'client-dart-1']);
  return { ...f, result, report: () => JSON.parse(readFileSync(`${f.root}/results/runs/client-dart-1/decompilation.json`, 'utf8')) };
}

test('a cut-off pack report leaves no target to analyse and still removes the network', () => {
  const f = decompile('bad-pack');
  expect(f.result.exitCode).toBe(0);
  expect(f.calls().filter((c) => c === 'run')).toHaveLength(1);
  expect(f.calls().at(-1)).toBe('network-rm');
  expect(f.report().targets).toEqual({});
  expect(f.report().pack.run.outcome).toBe('success');
});

test('a target the packer did not report as built is not analysed', () => {
  const f = decompile('not-built');
  expect(f.result.exitCode).toBe(0);
  expect(f.calls().filter((c) => c === 'run')).toHaveLength(1);
  expect(f.report().targets).toEqual({});
  expect(f.report().pack.web.built).toBe(false);
});

test('a cut-off analysis report scores zero instead of failing the run', () => {
  const f = decompile('bad-report');
  expect(f.result.exitCode).toBe(0);
  expect(f.calls().at(-1)).toBe('network-rm');
  expect(f.report().targets.web).toMatchObject({ outcome: 'success', hits: 0, hitRate: 0, answers: {} });
});

test('subscription analysis stops at the list-price budget', () => {
  const f = decompile('budget');
  expect(f.result.stderr.toString()).toBe('');
  expect(f.result.exitCode).toBe(0);
  expect(f.calls()).toContain('stop');
  expect(f.report().targets.web).toMatchObject({ budgetExceeded: true, outcome: 'budget_limit', billing: 'subscription', listPriceUsd: 6 });
});

test('the fallback shares the first session budget', () => {
  const f = decompile('fallback-budget', true);
  expect(f.result.stderr.toString()).toBe('');
  expect(f.result.exitCode).toBe(0);
  expect(f.calls()).toContain('stop');
  expect(f.report().targets.web).toMatchObject({ budgetExceeded: true, outcome: 'budget_limit', billing: 'api+subscription', listPriceUsd: 5.6 });
});

test('a fallback below budget completes normally', () => {
  const f = decompile('fallback-success', true);
  expect(f.result.stderr.toString()).toBe('');
  expect(f.result.exitCode).toBe(0);
  expect(f.calls()).not.toContain('stop');
  expect(f.report().targets.web).toMatchObject({ budgetExceeded: false, outcome: 'success', billing: 'api+subscription', listPriceUsd: 0.8 });
});

test('an API rejection before a session exists starts fresh on the subscription', () => {
  const f = decompile('fallback-no-session', true);
  expect(f.result.stderr.toString()).toBe('');
  expect(f.result.exitCode).toBe(0);
  expect(f.calls().filter((c) => c === 'run')).toHaveLength(4);
  expect(f.report().pack.run).toMatchObject({ outcome: 'success', billing: 'api+subscription' });
  expect(f.report().targets.web).toMatchObject({ outcome: 'success', billing: 'api+subscription' });
});

test('a completed result keeps success when final usage exceeds the budget', () => {
  const f = decompile('budget-complete');
  expect(f.result.exitCode).toBe(0);
  expect(f.calls()).not.toContain('stop');
  expect(f.report().targets.web).toMatchObject({ budgetExceeded: true, outcome: 'success', listPriceUsd: 6 });
});
