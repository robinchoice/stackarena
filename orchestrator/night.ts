// Starts the next contest run at night when nobody is at work. stackarena-night.timer calls it every
// 15 minutes from 01:30 to 02:15, once the Savor workflow Nachtschicht (00:00, done by about 01:30)
// is through; one run at a time, teams in the order of teams.json with backends first. A run ends at
// about 04:45 and is torn down by 05:00, so the 5-hour window of the subscription that holds its last
// request closes by 10:00 at the latest. Runs with the API key draw on the API credits instead and
// touch the subscription only once those are used up.
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
// Limit of a run that starts at 01:30; later starts get less, rounded down to the quarter hour
const HOURS = 3.25;
const END_HOUR = 5;
const QUIET_MINUTES = 20;
const RETRY_SECONDS = 30;

function sh(cmd: string[]) {
  const r = Bun.spawnSync(cmd, { cwd: REPO, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`${cmd.slice(0, 4).join(' ')} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
function skip(reason: string): never {
  console.log(`no run: ${reason}`);
  process.exit(0);
}

const now = new Date();
const minute = now.getHours() * 60 + now.getMinutes();
if (minute < 90 || minute >= 150) skip('outside the start window');
const end = new Date(now);
end.setHours(END_HOUR, 0, 0, 0);
const hours = Math.min(HOURS, Math.floor(((end.getTime() - now.getTime()) / 3_600_000) * 4) / 4);

const runUnits = ['stackarena-backend-*.service', 'stackarena-client-*.service'];
if (sh(['systemctl', '--user', 'list-units', ...runUnits, '--state=active', '--plain', '--no-legend']))
  skip('a run is going');
if (sh(['docker', 'ps', '-q', '--filter', 'name=stackarena-'])) skip('contest containers are running');

// Only sessions with someone at work hold a run back. The Savor workflows run every night and plan
// their own share of the subscription; Savor marks a workflow thread with `workflow` and the threads
// it starts with `unattended`. A thread whose last input from a person (`inputAt`) is older than the
// quiet time counts as unattended too, for example an agent told to work through the night.
// Sessions without such a thread, terminal sessions included, count.
const quietSince = now.getTime() - QUIET_MINUTES * 60_000;
const unattended = new Set<string>();
for (const file of new Bun.Glob('*/.savor/threads/*/thread.json').scanSync(`${homedir()}/dev`)) {
  try {
    const thread = JSON.parse(readFileSync(`${homedir()}/dev/${file}`, 'utf8'));
    if (thread.workflow || thread.unattended || Date.parse(thread.inputAt) < quietSince)
      for (const s of thread.agentSessions ?? []) unattended.add(s.sessionId);
  } catch {} // a thread Savor is writing right now: its sessions count
}
const sessions = [`${homedir()}/.claude/projects`, `${homedir()}/.codex/sessions`].filter((d) => existsSync(d));
const recent = sh(['find', ...sessions, '-name', '*.jsonl', '-mmin', `-${QUIET_MINUTES}`]).split('\n').filter(Boolean);
// Claude keeps <session>.jsonl and <session>/subagents/*.jsonl; Codex names the session in the first
// line of each rollout, so its guardian reviews map to the session they review
const session = (file: string) =>
  file.startsWith(`${homedir()}/.codex/`)
    ? JSON.parse(readFileSync(file, 'utf8').split('\n', 1)[0]).payload?.session_id
    : file.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
const busy = recent.find((f) => !unattended.has(session(f)));
if (busy) skip(`agent session active in the last ${QUIET_MINUTES} minutes: ${busy}`);

const teams = Object.keys(JSON.parse(readFileSync(`${REPO}/orchestrator/teams.json`, 'utf8')));
const next = [...teams.filter((t) => t.startsWith('backend/')), ...teams.filter((t) => t.startsWith('client/'))].find(
  (t) => !existsSync(`${REPO}/runs/${t.replace('/', '-')}-1`),
);
if (!next) skip('every team has run');

const id = `${next.replace('/', '-')}-1`;
const unit = `stackarena-${id}`;
// A start can fail within seconds, for example when the machine is still finishing a suspend and
// refuses the sleep inhibitor. Only a unit still active a minute later counts as started. A failed
// attempt moves what it created to results/aborted, so the team stays next in line.
let startedAt = now;
function start() {
  startedAt = new Date();
  sh([
    'systemd-run', '--user', '--unit', unit, '--same-dir', '--collect',
    'systemd-inhibit', '--what=sleep:idle', '--who=stackarena', `--why=contest run ${id}`,
    process.execPath, `${REPO}/orchestrator/run.ts`, '--team', next!, '--hours', String(hours),
  ]);
  Bun.sleepSync(60_000);
  if (Bun.spawnSync(['systemctl', '--user', 'is-active', '--quiet', unit]).exitCode === 0) return true;
  Bun.spawnSync(['systemctl', '--user', 'reset-failed', unit]);
  const aborted = `${REPO}/results/aborted/${id}-${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '')}`;
  mkdirSync(`${REPO}/results/aborted`, { recursive: true });
  if (existsSync(`${REPO}/results/runs/${id}`)) renameSync(`${REPO}/results/runs/${id}`, aborted);
  if (existsSync(`${REPO}/runs/${id}`)) {
    mkdirSync(aborted, { recursive: true });
    renameSync(`${REPO}/runs/${id}`, `${aborted}/repo`);
  }
  return false;
}

let started = start();
if (!started) {
  console.log(`start of ${id} failed, trying once more in ${RETRY_SECONDS} s`);
  Bun.sleepSync(RETRY_SECONDS * 1000);
  started = start();
}
if (!started) {
  console.log(`no run: start of ${id} failed twice, see journalctl --user -u ${unit}; ${next} stays next in line`);
  process.exit(1);
}
console.log(`started ${id}, limit ${hours} h, ends by ${new Date(startedAt.getTime() + hours * 3_600_000).toLocaleTimeString('de-DE')}`);
