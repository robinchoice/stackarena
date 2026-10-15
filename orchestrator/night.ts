// Starts the next contest run at night when nothing else is going on. stackarena-night.timer calls it
// every 15 minutes from 21:00 to 00:00; one run at a time, teams in the order of teams.json with
// backends first. A run gets 4 hours and ends by 04:00, so the 5-hour window of the subscription
// that holds its last request closes by 09:00 at the latest. Runs with the API key draw on the API
// credits instead and touch the subscription only once those are used up.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const HOURS = 4;
const END_HOUR = 4;
const QUIET_MINUTES = 20;

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
const end = new Date(now);
end.setHours(END_HOUR, 0, 0, 0);
if (end <= now) end.setDate(end.getDate() + 1);
const spareHours = (end.getTime() - now.getTime()) / 3_600_000 - HOURS;
if (spareHours < 0 || spareHours > 3) skip('outside the start window');

const runUnits = ['stackarena-backend-*.service', 'stackarena-client-*.service'];
if (sh(['systemctl', '--user', 'list-units', ...runUnits, '--state=active', '--plain', '--no-legend']))
  skip('a run is going');
if (sh(['docker', 'ps', '-q', '--filter', 'name=stackarena-'])) skip('contest containers are running');

const sessions = [`${homedir()}/.claude/projects`, `${homedir()}/.codex/sessions`].filter((d) => existsSync(d));
const recent = sh(['find', ...sessions, '-name', '*.jsonl', '-mmin', `-${QUIET_MINUTES}`, '-print', '-quit']);
if (recent) skip(`agent session active in the last ${QUIET_MINUTES} minutes: ${recent}`);

const teams = Object.keys(JSON.parse(readFileSync(`${REPO}/orchestrator/teams.json`, 'utf8')));
const next = [...teams.filter((t) => t.startsWith('backend/')), ...teams.filter((t) => t.startsWith('client/'))].find(
  (t) => !existsSync(`${REPO}/runs/${t.replace('/', '-')}-1`),
);
if (!next) skip('every team has run');

const id = `${next.replace('/', '-')}-1`;
sh([
  'systemd-run', '--user', '--unit', `stackarena-${id}`, '--same-dir', '--collect',
  'systemd-inhibit', '--what=sleep:idle', '--who=stackarena', `--why=contest run ${id}`,
  process.execPath, `${REPO}/orchestrator/run.ts`, '--team', next, '--hours', String(HOURS),
]);
console.log(`started ${id}, ends by ${new Date(now.getTime() + HOURS * 3_600_000).toLocaleTimeString('de-DE')}`);
