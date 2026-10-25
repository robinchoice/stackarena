import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  for (const file of ['run.ts', 'night.ts', 'decompile.ts', 'usage.ts', 'questions.ts', 'teams.json', 'prompt.md', 'pack.md', 'decompile.md']) {
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
} else if (args.includes('rev-parse')) {
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
const mounts = args.flatMap((x, i) => x === '-v' ? [args[i + 1]] : []);
const out = mounts.find(x => x.endsWith(':/out'))?.slice(0, -5);
const session = mounts.find(x => x.endsWith(':/home/agent/.claude/projects/-work'))?.split(':')[0] ?? process.env.OUT_DIR + '/session';
if (name.endsWith('-pack')) {
  mkdirSync(out + '/web', { recursive: true });
  writeFileSync(out + '/web/index.html', 'fixture');
  writeFileSync(out + '/pack.json', mode === 'bad-pack' ? '{' : JSON.stringify({ web: { built: true } }));
} else if (out) writeFileSync(out + '/report.json', JSON.stringify({ answers: {} }));
const resumed = args.includes('--resume');
const fallback = mode.startsWith('fallback');
const input = name.endsWith('-pack') ? 0 : mode === 'budget' || mode === 'budget-complete' ? 1500000 : mode === 'fallback-budget' ? 700000 : 100000;
appendFileSync(session + '/fixture.jsonl', JSON.stringify({ type: 'assistant', message: { id: resumed ? 'second' : 'first', usage: { input_tokens: input } } }) + '\\n');
if (!name.endsWith('-pack') && (mode === 'budget' || (mode === 'fallback-budget' && resumed))) await Bun.sleep(1000);
console.log(JSON.stringify(fallback && !resumed && !name.endsWith('-pack')
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
});

test('the first failed night start is archived before its retry', () => {
  const f = fixture('night-retry');
  const result = f.run('night.ts', []);
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
  expect(readFileSync(`${f.root}/starts`, 'utf8')).toBe('2');
  expect(result.stdout.toString()).toContain('started backend-bun-1');
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

function decompile(mode: string, api = false) {
  const f = fixture(mode, api);
  mkdirSync(`${f.root}/results/runs/client-dart-1`, { recursive: true });
  writeFileSync(`${f.root}/results/runs/client-dart-1/summary.json`, JSON.stringify({ team: 'client/dart' }));
  const result = f.run('decompile.ts', ['--run', 'client-dart-1']);
  return { ...f, result, report: () => JSON.parse(readFileSync(`${f.root}/results/runs/client-dart-1/decompilation.json`, 'utf8')) };
}

test('a malformed pack report still removes the network', () => {
  const f = decompile('bad-pack');
  expect(f.result.exitCode).not.toBe(0);
  expect(f.calls().at(-1)).toBe('network-rm');
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

test('a completed result keeps success when final usage exceeds the budget', () => {
  const f = decompile('budget-complete');
  expect(f.result.exitCode).toBe(0);
  expect(f.calls()).not.toContain('stop');
  expect(f.report().targets.web).toMatchObject({ budgetExceeded: true, outcome: 'success', listPriceUsd: 6 });
});
