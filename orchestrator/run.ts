// Starts one contest run in a locked-down container and records time, tokens and cost.
// Run it as its own user unit, so it outlives the shell or agent session that started it:
//   systemd-run --user --unit stackarena-backend-bun-1 --same-dir --collect \
//     bun orchestrator/run.ts --team backend/bun [--run 1] [--hours 4] [--smoke]
// Follow it with journalctl --user -fu stackarena-backend-bun-1.
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { usage } from './usage';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const MODEL = 'claude-opus-5-5';
const EFFORT = 'xhigh';
// Workspace of the API key in the Claude Console; the key is not scoped to it, so requests name it
const WORKSPACE = 'wrkspc_01LFUA1D63QwXUTV6V4wna2Y';

const { values } = parseArgs({
  options: {
    team: { type: 'string' },
    run: { type: 'string', default: '1' },
    hours: { type: 'string' },
    smoke: { type: 'boolean', default: false },
  },
});
const teams: Record<string, { name: string; stack: string; notes?: string[] }> = JSON.parse(
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

const secrets = readFileSync(`${homedir()}/.secrets`, 'utf8');
const secret = (name: string) =>
  new RegExp(`^export ${name}=(.+)$`, 'm').exec(secrets)?.[1].replace(/^['"]|['"]$/g, '') || undefined;
// The API key draws on the monthly API credits of the Max plan; the subscription token stays the
// fallback for when they run out.
const apiKey = secret('ANTHROPIC_STACKARENA_API_KEY');
const token = secret('CLAUDE_STACKARENA_TOKEN');
if (!token) throw new Error('CLAUDE_STACKARENA_TOKEN is missing in ~/.secrets (create it with claude setup-token)');

// A fresh repository with spec and harness only. The reference API never enters it, and a separate
// repository keeps it out of reach of git history as well.
mkdirSync(`${runDir}/${folder}`, { recursive: true });
mkdirSync(`${outDir}/session`, { recursive: true });
sh(['bash', '-c', `git -C "${REPO}" archive HEAD spec harness | tar -x -C "${runDir}"`]);
rmSync(`${runDir}/harness/reference`, { recursive: true, force: true });
writeFileSync(`${runDir}/${folder}/.gitkeep`, '');
sh(['git', 'init', '-q'], { cwd: runDir });
sh(['git', 'add', '--', 'spec', 'harness', folder], { cwd: runDir });
sh(['git', 'commit', '-q', '-m', 'Contest start'], { cwd: runDir });
const startCommit = sh(['git', 'rev-parse', 'HEAD'], { cwd: runDir });

const environment =
  (kind === 'backend'
    ? '- Postgres is running and `DATABASE_URL` is set. Check your server with\n  `cd harness && bun install && BASE_URL=http://localhost:8080 bun test api/`.'
    : '- A reference backend that implements `openapi.yaml` runs at `http://api:18080`\n  (`STACKARENA_API_URL`). Check your web build with `cd harness && bun install &&\n  TARGET=web CLIENT_URL=http://localhost:5173 BASE_URL=http://api:18080 bunx playwright test`.\n- This container builds and tests the web and Linux targets only. Set the other targets up so\n  they build on matching machines, and record their state in `STATUS.md`.') +
  // Team-specific conditions, one bullet each
  (team.notes ?? []).map((note) => `\n- ${note}`).join('');
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
// Credentials from the calling shell must not reach the agent; agent() adds exactly one kind
const { ANTHROPIC_API_KEY: _, CLAUDE_CODE_OAUTH_TOKEN: __, ...hostEnv } = process.env;
const env = {
  ...hostEnv,
  REPO,
  RUN_DIR: runDir,
  OUT_DIR: outDir,
  GIT_NAME: `Team ${team.name}`,
  GIT_EMAIL: `${kind}-${slug}@stackarena.test`,
};
const compose = (...args: string[]) => [
  'docker', 'compose', '-f', `${REPO}/orchestrator/compose.yaml`, '-p', project, '--profile', kind, ...args,
];
sh(compose('up', '-d', '--wait', kind === 'backend' ? 'db' : 'api'), { env });

const container = `${project}-agent`;
const transcriptFile = `${outDir}/transcript.jsonl`;
const started = new Date();
// Checked against the wall clock: a monotonic timer would stand still while the machine sleeps
const deadline = started.getTime() + hours * 3_600_000;
let timedOut = false;
const timer = setInterval(() => {
  if (timedOut || Date.now() < deadline) return;
  timedOut = true;
  Bun.spawnSync(['docker', 'stop', '-t', '30', container]);
}, 10_000);
const agent = (credentials: Record<string, string>, args: string[]) =>
  Bun.spawn(
    compose('run', '--rm', '-T', '--name', container, 'agent', 'claude', ...args, '--model', MODEL, '--effort', EFFORT,
      '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'),
    {
      env: { ...env, ...credentials },
      stdout: openSync(transcriptFile, 'a'),
      stderr: openSync(`${outDir}/stderr.log`, 'a'),
    },
  ).exited;

// The final result event exists only if the agent ended the session itself
function lastResult(): Record<string, any> | null {
  let result = null;
  for (const line of readFileSync(transcriptFile, 'utf8').split('\n')) {
    if (!line.includes('"type":"result"')) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'result') result = event;
    } catch {}
  }
  return result;
}

console.log(`${id}: started ${started.toISOString()}, limit ${hours} h, ${apiKey ? 'API credits' : 'subscription'}`);
let billing = apiKey ? 'api' : 'subscription';
const credentials = apiKey
  ? { ANTHROPIC_API_KEY: apiKey, ANTHROPIC_CUSTOM_HEADERS: `anthropic-workspace-id: ${WORKSPACE}` }
  : { CLAUDE_CODE_OAUTH_TOKEN: token };
let exitCode = await agent(credentials, ['-p', prompt]);
// Used-up credits or a key the API refuses end the session with an API error. The run carries on in
// the same session on the subscription until its deadline, so it stays comparable to the others.
const failed = lastResult();
if (apiKey && !timedOut && failed?.is_error && failed.api_error_status && failed.session_id) {
  billing = 'api+subscription';
  console.log(`${id}: API key failed with ${failed.api_error_status}, continuing on the subscription`);
  exitCode = await agent({ CLAUDE_CODE_OAUTH_TOKEN: token }, [
    '--resume', failed.session_id, '-p',
    'The run continues after an API error that interrupted it. Carry on where you left off.',
  ]);
}
clearInterval(timer);
const ended = new Date();
sh(compose('down', '-v'), { env });

const result = lastResult();
const used = usage(outDir);
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
  billing,
  outcome: result?.subtype ?? (timedOut ? 'time_limit' : 'no_result'),
  turns: billing === 'api+subscription' ? null : (result?.num_turns ?? null),
  requests: used.requests,
  tokens: used.tokens,
  usageSource: used.source,
  // The result event of a resumed session counts its second part only
  listPriceUsd: Math.round(((billing === 'api+subscription' ? null : result?.total_cost_usd) ?? used.usd) * 100) / 100,
  commits: Number(sh(['git', 'rev-list', '--count', `${startCommit}..${finalCommit}`], { cwd: runDir })),
  finalCommit,
  changedFiles: changed.length,
  changedOutsideFolder: changed.filter((f) => !f.startsWith(`${folder}/`)),
};
writeFileSync(`${outDir}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
