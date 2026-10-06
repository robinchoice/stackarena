// Starts one contest run in a locked-down container and records time, tokens and cost.
//   bun orchestrator/run.ts --team backend/bun [--run 1] [--hours 4] [--smoke]
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const MODEL = 'claude-opus-5-5';
const EFFORT = 'xhigh';
// List prices in $ per million tokens for MODEL; subscription runs are valued at these
const PRICE = { input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 };

const { values } = parseArgs({
  options: {
    team: { type: 'string' },
    run: { type: 'string', default: '1' },
    hours: { type: 'string' },
    smoke: { type: 'boolean', default: false },
  },
});
const teams: Record<string, { name: string; stack: string }> = JSON.parse(
  readFileSync(`${REPO}/orchestrator/teams.json`, 'utf8'),
);
const key = values.team ?? '';
const team = teams[key];
if (!team) throw new Error(`--team must be one of: ${Object.keys(teams).join(', ')}`);
const [kind, slug] = key.split('/') as ['client' | 'backend', string];
const folder = `${kind}s/${slug}`;
const hours = Number(values.hours ?? (values.smoke ? 0.1 : 4));
const id = `${values.smoke ? 'smoke-' : ''}${kind}-${slug}-${values.run}`;
const runDir = `${REPO}/runs/${id}`;
const outDir = `${REPO}/results/runs/${id}`;
if (existsSync(runDir) || existsSync(outDir)) throw new Error(`run ${id} exists already`);

function sh(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const r = Bun.spawnSync(cmd, { ...opts, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`${cmd.slice(0, 4).join(' ')} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const secret = /^export CLAUDE_STACKARENA_TOKEN=(.+)$/m.exec(readFileSync(`${homedir()}/.secrets`, 'utf8'))?.[1];
const token = secret?.replace(/^['"]|['"]$/g, '');
if (!token) throw new Error('CLAUDE_STACKARENA_TOKEN is missing in ~/.secrets (create it with claude setup-token)');

// A fresh repository with spec and harness only. The reference API never enters it, and a separate
// repository keeps it out of reach of git history as well.
mkdirSync(`${runDir}/${folder}`, { recursive: true });
mkdirSync(outDir, { recursive: true });
sh(['bash', '-c', `git -C "${REPO}" archive HEAD spec harness | tar -x -C "${runDir}"`]);
rmSync(`${runDir}/harness/reference`, { recursive: true, force: true });
writeFileSync(`${runDir}/${folder}/.gitkeep`, '');
sh(['git', 'init', '-q'], { cwd: runDir });
sh(['git', 'add', '--', 'spec', 'harness', folder], { cwd: runDir });
sh(['git', 'commit', '-q', '-m', 'Contest start'], { cwd: runDir });
const startCommit = sh(['git', 'rev-parse', 'HEAD'], { cwd: runDir });

const environment =
  kind === 'backend'
    ? '- Postgres is running and `DATABASE_URL` is set. Check your server with\n  `cd harness && bun install && BASE_URL=http://localhost:8080 bun test api/`.'
    : '- A reference backend that implements `openapi.yaml` runs at `http://api:18080`\n  (`STACKARENA_API_URL`). Check your web build with `cd harness && bun install &&\n  TARGET=web CLIENT_URL=http://localhost:5173 BASE_URL=http://api:18080 bunx playwright test`.\n- This container builds and tests the web and Linux targets only. Set the other targets up so\n  they build on matching machines, and record their state in `STATUS.md`.';
const prompt = values.smoke
  ? `Smoke test of the contest setup. In /work create \`${folder}/STATUS.md\` containing the word smoke and commit it. Then run \`cd harness && bun install\` and \`node --version\`. Report the outcome in one sentence and stop.`
  : readFileSync(`${REPO}/orchestrator/prompt.md`, 'utf8')
      .replaceAll('{{NAME}}', team.name)
      .replaceAll('{{KIND}}', kind)
      .replaceAll('{{STACK}}', team.stack)
      .replaceAll('{{FOLDER}}', folder)
      .replaceAll('{{HOURS}}', String(hours))
      .replaceAll('{{ENVIRONMENT}}', environment);
writeFileSync(`${outDir}/prompt.md`, prompt);

const project = `stackarena-${id}`;
const env = {
  ...process.env,
  REPO,
  RUN_DIR: runDir,
  GIT_NAME: `Team ${team.name}`,
  GIT_EMAIL: `${kind}-${slug}@stackarena.test`,
  CLAUDE_CODE_OAUTH_TOKEN: token,
};
const compose = (...args: string[]) => [
  'docker', 'compose', '-f', `${REPO}/orchestrator/compose.yaml`, '-p', project, '--profile', kind, ...args,
];
sh(compose('up', '-d', '--wait', kind === 'backend' ? 'db' : 'api'), { env });

const container = `${project}-agent`;
const started = new Date();
console.log(`${id}: started ${started.toISOString()}, limit ${hours} h`);
const agent = Bun.spawn(
  compose('run', '--rm', '-T', '--name', container, 'agent', 'claude', '-p', prompt, '--model', MODEL, '--effort', EFFORT,
    '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'),
  { env, stdout: Bun.file(`${outDir}/transcript.jsonl`), stderr: Bun.file(`${outDir}/stderr.log`) },
);
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  Bun.spawnSync(['docker', 'stop', '-t', '30', container]);
}, hours * 3_600_000);
const exitCode = await agent.exited;
clearTimeout(timer);
const ended = new Date();
sh(compose('down', '-v'), { env });

// Usage from the transcript: one entry per API message, the final result if the run ended itself
const usage = new Map<string, Record<string, any>>();
let result: Record<string, any> | null = null;
for (const line of readFileSync(`${outDir}/transcript.jsonl`, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let e: Record<string, any>;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  if (e.type === 'assistant' && e.message?.usage) usage.set(e.message.id, e.message.usage);
  if (e.type === 'result') result = e;
}
const tokens = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
for (const u of usage.values()) {
  tokens.input += u.input_tokens ?? 0;
  tokens.output += u.output_tokens ?? 0;
  tokens.cacheRead += u.cache_read_input_tokens ?? 0;
  const split = u.cache_creation ?? {};
  if (split.ephemeral_5m_input_tokens === undefined && split.ephemeral_1h_input_tokens === undefined)
    tokens.cacheWrite5m += u.cache_creation_input_tokens ?? 0;
  tokens.cacheWrite5m += split.ephemeral_5m_input_tokens ?? 0;
  tokens.cacheWrite1h += split.ephemeral_1h_input_tokens ?? 0;
}
const estimated = Object.entries(tokens).reduce((sum, [k, n]) => sum + (n * PRICE[k as keyof typeof PRICE]) / 1e6, 0);
const finalCommit = sh(['git', 'rev-parse', 'HEAD'], { cwd: runDir });
const changed = sh(['git', 'diff', '--name-only', startCommit, finalCommit], { cwd: runDir }).split('\n').filter(Boolean);

const summary = {
  id,
  team: key,
  model: MODEL,
  effort: EFFORT,
  sourceCommit: sh(['git', '-C', REPO, 'rev-parse', 'HEAD']),
  started: started.toISOString(),
  ended: ended.toISOString(),
  minutes: Math.round((ended.getTime() - started.getTime()) / 6000) / 10,
  limitHours: hours,
  timedOut,
  exitCode,
  outcome: result?.subtype ?? (timedOut ? 'time_limit' : 'no_result'),
  turns: result?.num_turns ?? null,
  requests: usage.size,
  tokens,
  listPriceUsd: Math.round((result?.total_cost_usd ?? estimated) * 100) / 100,
  commits: Number(sh(['git', 'rev-list', '--count', `${startCommit}..${finalCommit}`], { cwd: runDir })),
  finalCommit,
  changedFiles: changed.length,
  changedOutsideFolder: changed.filter((f) => !f.startsWith(`${folder}/`)),
};
writeFileSync(`${outDir}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
