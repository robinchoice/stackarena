// Decompilation column: takes the shipped build of a client team apart without its source and
// scores the answers against spec/. Informational, it never enters the contest score.
//   bun orchestrator/decompile.ts --run client-dart-1
//   bun orchestrator/decompile.ts --smoke [--run 1]
// Like a contest run it is best started as its own user unit, so it outlives the session:
//   systemd-run --user --unit stackarena-decompile-client-dart-1 --same-dir --collect \
//     bun orchestrator/decompile.ts --run client-dart-1
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { questions } from './questions';
import { usage } from './usage';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const MODEL = 'claude-opus-5-5';
const EFFORT = 'high';
const WORKSPACE = 'wrkspc_01LFUA1D63QwXUTV6V4wna2Y';
// Fixed budget per analysis, the same for every team, so the numbers stay comparable
const PACK = { minutes: 30, budget: 5 };
const ANALYSIS = { minutes: 45, budget: 5 };
const TARGETS = ['web', 'linux'] as const;
const SKILL = `${homedir()}/dev/rea/skills/reverse-engineer-anything`;

const { values } = parseArgs({
  options: {
    run: { type: 'string' },
    smoke: { type: 'boolean', default: false },
    minutes: { type: 'string' },
    budget: { type: 'string' },
  },
});
if (values.minutes) ANALYSIS.minutes = Number(values.minutes);
if (values.budget) ANALYSIS.budget = Number(values.budget);

function sh(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}) {
  const r = Bun.spawnSync(cmd, { ...opts, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`${cmd.slice(0, 4).join(' ')} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const secrets = readFileSync(`${homedir()}/.secrets`, 'utf8');
const secret = (name: string) =>
  new RegExp(`^export ${name}=(.+)$`, 'm').exec(secrets)?.[1].replace(/^['"]|['"]$/g, '') || undefined;
// Same billing as a contest run: API credits of the Max plan first, the subscription as fallback
const apiKey = secret('ANTHROPIC_STACKARENA_API_KEY');
const token = secret('CLAUDE_STACKARENA_TOKEN');
if (!token) throw new Error('CLAUDE_STACKARENA_TOKEN is missing in ~/.secrets (create it with claude setup-token)');

const teams: Record<string, { name: string; stack: string }> = JSON.parse(
  readFileSync(`${REPO}/orchestrator/teams.json`, 'utf8'),
);

// The run whose build gets taken apart. --smoke builds the approved mockup as a client instead, so
// the whole chain can be checked without a contest run.
const smokeTeam = { name: 'Smoke', stack: 'the mockup as a web client (JavaScript)' };
const run = values.smoke ? `smoke-decompile-${values.run ?? '1'}` : (values.run ?? '');
const teamKey = values.smoke ? 'orchestrator/decompile-smoke' : (readRunTeam(run) ?? '');
const team = values.smoke ? smokeTeam : teams[teamKey];
function readRunTeam(id: string) {
  const file = `${REPO}/results/runs/${id}/summary.json`;
  if (!existsSync(file)) throw new Error(`no run ${id} in results/runs`);
  return JSON.parse(readFileSync(file, 'utf8')).team as string;
}
if (!team) throw new Error(`run ${run} belongs to team ${teamKey}, which teams.json does not know`);
if (!values.smoke && !teamKey.startsWith('client/')) throw new Error(`${teamKey} is not a client team`);

const packDir = `${REPO}/runs/${run}-decompile`;
const outDir = `${REPO}/results/runs/${run}/decompile`;
if (existsSync(packDir) || existsSync(outDir)) throw new Error(`${run} has been analysed already`);
mkdirSync(`${packDir}/out`, { recursive: true });
mkdirSync(outDir, { recursive: true });

// Containers need a network of their own: on the default bridge their resolver is the host's, which
// init.sh rejects along with the rest of the private network
const network = `stackarena-decompile-${run}`;

// The backend address is a one-off, so a build that carries it cannot have it from anywhere else
const apiUrl = `http://api-${crypto.randomUUID().slice(0, 8)}.stackarena.test:18080`;
const ASK = questions(apiUrl);

type Agent = {
  image: string;
  dir: string;
  prompt: string;
  minutes: number;
  budget: number;
  mounts: string[];
  env?: Record<string, string>;
};
// One agent session, billed like a contest run: it carries on on the subscription when the API
// credits are gone. Returns what the run cost and how long it took.
async function agent(name: string, a: Agent) {
  const container = `stackarena-decompile-${run}-${name}`;
  const transcriptFile = `${a.dir}/transcript.jsonl`;
  mkdirSync(`${a.dir}/session`, { recursive: true });
  writeFileSync(`${a.dir}/prompt.md`, a.prompt);
  const started = new Date();
  const deadline = started.getTime() + a.minutes * 60_000;
  let timedOut = false;
  let budgetExceeded = false;
  const checkLimits = () => {
    timedOut ||= Date.now() >= deadline;
    budgetExceeded ||= usage(a.dir).usd >= a.budget;
    return timedOut || budgetExceeded;
  };
  const timer = setInterval(() => {
    if (checkLimits()) Bun.spawnSync(['docker', 'stop', '-t', '30', container]);
  }, 2000);
  const start = (credentials: Record<string, string>, args: string[]) =>
    Bun.spawn(
      [
        'docker', 'run', '--rm', '--name', container,
        '--network', network, '--cap-add', 'NET_ADMIN', '--sysctl', 'net.ipv6.conf.all.disable_ipv6=1',
        '--cpus', '6', '--memory', '12g', '--shm-size', '1g',
        ...a.mounts.flatMap((m) => ['-v', m]),
        '-v', `${a.dir}/session:/home/agent/.claude/projects/-work`,
        ...Object.entries({ ...a.env, ...credentials, DISABLE_AUTOUPDATER: '1' }).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        a.image, 'claude', ...args, '--model', MODEL, '--effort', EFFORT, '--dangerously-skip-permissions',
        ...(credentials.ANTHROPIC_API_KEY ? ['--max-budget-usd', String(a.budget)] : []),
        '--output-format', 'stream-json', '--verbose',
      ],
      { stdout: openSync(transcriptFile, 'a'), stderr: openSync(`${a.dir}/stderr.log`, 'a') },
    ).exited;

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

  let billing = apiKey ? 'api' : 'subscription';
  console.log(`${run} ${name}: started ${started.toISOString()}, ${a.minutes} min, ${a.budget} $, ${billing}`);
  let exitCode = 0;
  let completed = false;
  try {
    exitCode = await start(
      apiKey
        ? { ANTHROPIC_API_KEY: apiKey, ANTHROPIC_CUSTOM_HEADERS: `anthropic-workspace-id: ${WORKSPACE}` }
        : { CLAUDE_CODE_OAUTH_TOKEN: token! },
      ['-p', a.prompt],
    );
    const failed = lastResult();
    if (apiKey && !checkLimits() && failed?.is_error && failed.api_error_status && failed.session_id) {
      billing = 'api+subscription';
      console.log(`${run} ${name}: API key failed with ${failed.api_error_status}, continuing on the subscription`);
      exitCode = await start({ CLAUDE_CODE_OAUTH_TOKEN: token! }, [
        '--resume', failed.session_id, '-p',
        'The analysis continues after an API error that interrupted it. Carry on where you left off.',
      ]);
    }
    completed = true;
  } finally {
    clearInterval(timer);
    if (!completed) Bun.spawnSync(['docker', 'rm', '-f', container]);
  }
  const ended = new Date();
  const result = lastResult();
  const used = usage(a.dir);
  budgetExceeded ||= used.usd >= a.budget;
  return {
    started: started.toISOString(),
    ended: ended.toISOString(),
    minutes: Math.round((ended.getTime() - started.getTime()) / 6000) / 10,
    limitMinutes: a.minutes,
    budgetUsd: a.budget,
    timedOut,
    budgetExceeded,
    exitCode,
    billing,
    outcome: exitCode === 0 && result?.subtype === 'success' ? 'success'
      : timedOut ? 'time_limit' : budgetExceeded ? 'budget_limit' : (result?.subtype ?? 'no_result'),
    error: result?.is_error ? String(result.result).slice(0, 200) : null,
    requests: used.requests,
    tokens: used.tokens,
    usageSource: used.source,
    listPriceUsd:
      Math.round(((billing === 'api+subscription' ? null : result?.total_cost_usd) ?? used.usd) * 100) / 100,
  };
}

// A report the agent left behind. A file cut off by the stop at the deadline counts as none.
function readJson(file: string): Record<string, any> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.log(`${run}: ${file} is not valid JSON: ${(e as Error).message}`);
    return {};
  }
}

const template = (file: string, fill: Record<string, string>) =>
  Object.entries(fill).reduce((s, [k, v]) => s.replaceAll(`{{${k}}}`, v), readFileSync(`${REPO}/orchestrator/${file}`, 'utf8'));

const sourceCommit = sh(['git', '-C', REPO, 'rev-parse', 'HEAD']);
let networkCreated = false;
try {
  sh(['bash', '-c', `docker network inspect ${network} >/dev/null 2>&1 || docker network create ${network}`]);
  networkCreated = true;
  // Step 1: build what ships. The smoke client has a build script, a team's repo needs an agent that
  // knows its stack.
  let pack: Record<string, any>;
  if (values.smoke) {
    sh(['bash', '-c', `git -C "${REPO}" archive ${sourceCommit} spec orchestrator/decompile-smoke | tar -x -C "${packDir}"`]);
    const build = 'orchestrator/decompile-smoke/build-web.sh';
    sh(['bash', build], { cwd: packDir, env: { ...process.env, STACKARENA_API_URL: apiUrl } });
    sh(['cp', '-r', `${packDir}/orchestrator/decompile-smoke/dist`, `${packDir}/out/web`]);
    pack = { web: { built: true, command: build, note: 'built on the host, no agent' }, linux: { built: false } };
  } else {
    const [kind, slug] = teamKey.split('/');
    const src = `${packDir}/src`;
    mkdirSync(src, { recursive: true });
    sh(['bash', '-c', `git -C "${REPO}/runs/${run}" archive HEAD | tar -x -C "${src}"`]);
    const packRun = await agent('pack', {
      image: 'stackarena-run:2',
      dir: `${outDir}/pack`,
      prompt: template('pack.md', {
        NAME: team.name,
        STACK: team.stack,
        FOLDER: `${kind}s/${slug}`,
        MINUTES: String(PACK.minutes),
      }),
      ...PACK,
      mounts: [`${src}:/work`, `${packDir}/out:/out`],
      env: { STACKARENA_API_URL: apiUrl },
    });
    pack = { ...readJson(`${packDir}/out/pack.json`), run: packRun };
  }

  // Step 2: one analysis per target whose build finished. Files of a build the packer did not
  // report as built, for example one stopped at the deadline, are not analysed.
  const results: Record<string, any> = {};
  for (const target of TARGETS) {
    const input = `${packDir}/out/${target}`;
    if (pack[target]?.built !== true || !existsSync(input) || !readdirSync(input).length) continue;
    const dir = `${outDir}/${target}`;
    const work = `${packDir}/work/${target}`;
    mkdirSync(`${dir}/out`, { recursive: true });
    mkdirSync(`${work}/input`, { recursive: true });
    mkdirSync(`${work}/scratch`, { recursive: true });
    const analysis = await agent(target, {
      image: 'stackarena-rea:1',
      dir,
      prompt: template('decompile.md', {
        TARGET: target === 'web' ? 'web' : 'Linux desktop',
        MINUTES: String(ANALYSIS.minutes),
        BUDGET: String(ANALYSIS.budget),
        QUESTIONS: ASK.map((q) => `- \`${q.id}\`: ${q.ask}`).join('\n'),
      }),
      ...ANALYSIS,
      mounts: [
        // /work itself has to be writable for the agent, the build inside it read-only
        `${work}:/work`,
        `${input}:/work/input:ro`,
        `${dir}/out:/out`,
        `${SKILL}:/home/agent/.claude/skills/reverse-engineer-anything:ro`,
      ],
    });
    const report = readJson(`${dir}/out/report.json`);
    const answers = report.answers ?? {};
    const scores = Object.fromEntries(ASK.map((q) => [q.id, Math.round(q.score(answers[q.id]?.answer) * 100) / 100]));
    const hits = Object.values(scores).reduce((a, b) => a + b, 0);
    results[target] = {
      ...analysis,
      hits: Math.round(hits * 100) / 100,
      hitRate: Math.round((hits / ASK.length) * 100) / 100,
      scores,
      tools: report.tools ?? [],
      note: report.note ?? null,
      answers,
    };
    console.log(`${run} ${target}: ${results[target].hitRate} of the answers, ${analysis.listPriceUsd} $`);
  }

  const report = {
    run,
    team: teamKey,
    model: MODEL,
    effort: EFFORT,
    sourceCommit,
    apiUrl,
    questions: ASK.map((q) => q.id),
    pack,
    targets: results,
    listPriceUsd:
      Math.round(
        ([pack.run, ...Object.values(results)].reduce((s: number, r: any) => s + (r?.listPriceUsd ?? 0), 0)) * 100,
      ) / 100,
  };
  writeFileSync(`${REPO}/results/runs/${run}/decompilation.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  rmSync(`${packDir}/work`, { recursive: true, force: true });
  if (networkCreated) sh(['docker', 'network', 'rm', network]);
}
