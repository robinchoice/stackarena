// Read-only live view of contest runs: bun orchestrator/live/server.ts, then open http://127.0.0.1:4520
// It tails each run's transcript and looks into the run repository; it never writes to either.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { priceOf, sessionFiles, tokensOf, usage } from '../usage';

const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const RESULTS = `${REPO}/results/runs`;
const RUNS = `${REPO}/runs`;
const ID = /^[a-z0-9-]+$/;
const TEAMS: Record<string, { name: string; stack: string }> = JSON.parse(
  readFileSync(`${REPO}/orchestrator/teams.json`, 'utf8'),
);

type Item = Record<string, unknown> & { k: string };

// Async, so git and docker calls for many runs do not block the server
async function run(cmd: string[], cwd?: string): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'ignore', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return code === 0 ? out.trim() : '';
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

// Recomputes only when a file has grown or changed, so polling many runs stays cheap
const cache = new Map<string, { stamp: string; value: unknown }>();
function cached<T>(key: string, files: string[], compute: () => T): T {
  const stamp = files.map((f) => (existsSync(f) ? `${statSync(f).size}:${statSync(f).mtimeMs}` : '-')).join('|');
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) return hit.value as T;
  const value = compute();
  cache.set(key, { stamp, value });
  return value;
}

function meta(id: string) {
  const plain = id.replace(/^smoke-/, '');
  const kind = plain.split('-')[0] as 'client' | 'backend';
  const slug = plain.split('-').slice(1, -1).join('-');
  const team = TEAMS[`${kind}/${slug}`];
  return { kind, slug, folder: `${kind}s/${slug}`, name: team?.name ?? slug, stack: team?.stack ?? '', smoke: id !== plain, run: plain.split('-').at(-1) };
}

const resultText = (b: any) =>
  Array.isArray(b.content) ? b.content.map((c: any) => c.text ?? '').join('\n') : String(b.content ?? '');

// Turns one transcript line into the few things worth showing
function items(line: string): Item[] {
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    return [];
  }
  const out: Item[] = [];
  if (e.type === 'assistant') {
    for (const b of e.message?.content ?? []) {
      if (b.type === 'text' && b.text.trim()) out.push({ k: 'text', text: b.text });
      if (b.type === 'tool_use') {
        const i = b.input ?? {};
        let title = b.name;
        let detail = '';
        if (b.name === 'Bash') [title, detail] = [i.description || 'Shell', i.command ?? ''];
        else if (b.name === 'Write') [title, detail] = [`Schreibt ${i.file_path}`, `${(i.content ?? '').split('\n').length} Zeilen`];
        else if (b.name === 'Edit' || b.name === 'MultiEdit') title = `Ändert ${i.file_path}`;
        else if (b.name === 'Read') title = `Liest ${i.file_path}`;
        else if (b.name === 'Grep' || b.name === 'Glob') title = `Sucht ${i.pattern}`;
        else if (b.name === 'Task' || b.name === 'Agent') [title, detail] = [`Subagent: ${i.description ?? ''}`, i.prompt ?? ''];
        else if (b.name === 'TodoWrite') {
          title = 'Plan aktualisiert';
          out.push({ k: 'plan', todos: i.todos ?? [] });
        } else if (b.name === 'WebFetch' || b.name === 'WebSearch') title = `${b.name}: ${i.url ?? i.query ?? ''}`;
        out.push({ k: 'tool', id: b.id, name: b.name, title, detail: clip(String(detail), 4000) });
      }
    }
  } else if (e.type === 'user') {
    for (const b of e.message?.content ?? []) {
      if (b.type === 'tool_result') out.push({ k: 'result', id: b.tool_use_id, error: !!b.is_error, text: clip(resultText(b), 6000) });
    }
  } else if (e.type === 'rate_limit_event') {
    const w = e.rate_limit_info?.unifiedWindows ?? {};
    out.push({ k: 'quota', fiveHour: w.five_hour?.utilization, week: w.seven_day?.utilization, status: e.rate_limit_info?.status });
  } else if (e.type === 'system' && e.subtype === 'api_retry') {
    out.push({ k: 'sys', text: `API-Fehler ${e.error_status}: ${e.error}, neuer Versuch ${e.attempt}` });
  } else if (e.type === 'result') {
    out.push({ k: 'end', text: e.result ?? '', outcome: e.subtype });
  }
  return out;
}

// Test results the agent produced itself: bun test (API) and Playwright (web) summaries
type Tests = { suite: string; pass: number; fail: number; cases: { name: string; ok: boolean }[]; at: string | null; count: number };
function testRuns(dir: string): Tests[] {
  const files = sessionFiles(dir);
  const sources = files.length ? files : [`${dir}/transcript.jsonl`];
  return cached(`tests:${dir}`, sources, () => {
    const runs: Tests[] = [];
    for (const file of sources)
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('tool_result')) continue;
        let e: any;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e.type !== 'user') continue;
        for (const b of e.message?.content ?? []) {
          if (b?.type !== 'tool_result') continue;
          const t = resultText(b);
          const bun = /^\s*(\d+) pass\s*$[\s\S]*?^\s*(\d+) fail\s*$/m.exec(t);
          // Playwright's summary line, e.g. "  34 passed (12.3s)"; Schemathesis also prints "805 passed"
          const pw = /^\s*(\d+) passed \(/m.exec(t);
          const pwFailed = /^\s*(\d+) failed\s*$/m.exec(t);
          if (!bun && !pw && !pwFailed) continue;
          const cases = [...t.matchAll(/^\((pass|fail)\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map((m) => ({ name: m[2]!, ok: m[1] === 'pass' }));
          for (const m of t.matchAll(/^\s*([✓✘×])\s+\d+\s+(.+?)(?: \(\d.*\))?$/gm)) cases.push({ name: m[2]!, ok: m[1] === '✓' });
          const pass = bun ? +bun[1]! : +(pw?.[1] ?? 0);
          const fail = bun ? +bun[2]! : +(/(\d+) failed/.exec(t)?.[1] ?? 0);
          runs.push({ suite: bun ? 'API' : 'Web', pass, fail, cases, at: e.timestamp ?? null, count: runs.length + 1 });
        }
      }
    return runs;
  });
}

// Cumulative list price over time, from the session log's timestamps
function series(dir: string, started: number): { m: number; usd: number }[] {
  const files = sessionFiles(dir);
  return cached(`series:${dir}`, files, () => {
    const msgs = new Map<string, { t: number; u: any }>();
    for (const file of files)
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('"usage"')) continue;
        try {
          const e = JSON.parse(line);
          if (e.type === 'assistant' && e.message?.usage && e.timestamp)
            msgs.set(e.message.id, { t: msgs.get(e.message.id)?.t ?? Date.parse(e.timestamp), u: e.message.usage });
        } catch {}
      }
    const sorted = [...msgs.values()].sort((a, b) => a.t - b.t);
    const out: { m: number; usd: number }[] = [];
    let usd = 0;
    for (const { t, u } of sorted) {
      usd += priceOf(tokensOf(u));
      out.push({ m: Math.round((t - started) / 6000) / 10, usd: Math.round(usd * 100) / 100 });
    }
    const step = Math.max(1, Math.ceil(out.length / 80));
    return out.filter((_, i) => i % step === 0 || i === out.length - 1);
  });
}

// Latest subscription utilisation the transcript reported
function quota(transcript: string): Item | null {
  const at = transcript.lastIndexOf('{"type":"rate_limit_event"');
  if (at < 0) return null;
  const end = transcript.indexOf('\n', at);
  return items(transcript.slice(at, end < 0 ? undefined : end))[0] ?? null;
}

async function container(id: string) {
  const ip = await run(['docker', 'inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', `stackarena-${id}-agent`]);
  return { running: ip !== '', ip };
}

async function reachable(url: string) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.status < 500;
  } catch {
    return false;
  }
}

async function listRuns() {
  if (!existsSync(RESULTS)) return [];
  const ids = readdirSync(RESULTS).filter((id) => ID.test(id) && existsSync(`${RESULTS}/${id}/transcript.jsonl`));
  const list = await Promise.all(ids.map(async (id) => {
    const done = existsSync(`${RESULTS}/${id}/summary.json`);
    return { id, ...meta(id), done, live: !done && (await container(id)).running, started: statSync(`${RESULTS}/${id}/prompt.md`).mtime };
  }));
  return list.sort((a, b) => +b.started - +a.started);
}

async function state(id: string) {
  const dir = `${RESULTS}/${id}`;
  const repo = `${RUNS}/${id}`;
  const m = meta(id);
  const summary = existsSync(`${dir}/summary.json`) ? JSON.parse(readFileSync(`${dir}/summary.json`, 'utf8')) : null;
  const started = summary?.started ?? statSync(`${dir}/prompt.md`).mtime.toISOString();
  const limitHours = summary?.limitHours ?? (m.smoke ? 0.1 : 4);
  const transcript = `${dir}/transcript.jsonl`;
  const u = cached(`usage:${dir}`, [transcript, ...sessionFiles(dir)], () => usage(dir));
  const q = cached(`quota:${dir}`, [transcript], () => quota(readFileSync(transcript, 'utf8')));

  const first = await run(['git', 'rev-list', '--max-parents=0', 'HEAD'], repo);
  const [log, diff, status, listed, c] = await Promise.all([
    run(['git', 'log', '--format=%h%x09%cI%x09%s', `${first}..HEAD`], repo),
    run(['git', 'diff', '--name-status', first, 'HEAD', '--', m.folder], repo),
    run(['git', 'status', '--porcelain', '--', m.folder], repo),
    run(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '--', m.folder], repo),
    container(id),
  ]);
  const commits = log
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [hash, at, subject] = l.split('\t');
      return { hash, at, subject };
    });
  const changed = new Map<string, string>();
  for (const l of diff.split('\n').filter(Boolean)) {
    const [s, f] = l.split('\t');
    changed.set(f!, s === 'A' ? 'neu' : 'geändert');
  }
  for (const l of status.split('\n').filter(Boolean))
    changed.set(l.slice(3), 'offen');
  const files = await Promise.all(listed
    .split('\n')
    .filter((f) => f && !f.includes('node_modules/'))
    .slice(0, 600)
    .map(async (f) => {
      let lines = 0;
      try {
        const file = Bun.file(`${repo}/${f}`);
        if (file.size < 400_000) lines = (await file.text()).split('\n').length;
      } catch {}
      return { path: f.slice(m.folder.length + 1), lines, status: changed.get(f) ?? '' };
    }));
  const code = files
    .filter((f) => !/(^|\/)([^/]*\.lock|package-lock\.json|[^/]*_snapshot\.json)$/.test(f.path))
    .reduce((s, f) => s + f.lines, 0);

  let preview: string | null = null;
  let server: boolean | null = null;
  if (c.running && m.kind === 'client' && (await reachable(`http://${c.ip}:5173/`))) preview = `http://${c.ip}:5173/`;
  if (c.running && m.kind === 'backend') server = await reachable(`http://${c.ip}:8080/health`);
  const tests = testRuns(dir);

  return {
    id, ...m, started, limitHours, live: !summary && c.running, summary,
    // A run that stopped without a summary ends where its transcript does
    ended: summary?.ended ?? (c.running ? null : statSync(transcript).mtime.toISOString()),
    requests: u.requests, tokens: u.tokens, usd: u.usd, usageSource: u.source, quota: q,
    series: series(dir, Date.parse(started)),
    commits, files, code, preview, server,
    // grade.ts works in this copy while it grades, after summary.json is written
    grading: !summary?.grade && existsSync(`${RUNS}/${id}-grade`),
    tests: tests.at(-1) ?? null, testRuns: tests.length,
  };
}

// One stream for many runs (?runs=<id>:<byte offset>,…): sends each transcript from its offset,
// then follows the files as they grow. `to` is the offset after the last complete line, so the
// page can reconnect with it instead of loading everything again
function events(spec: string) {
  const feeds = spec.split(',').map((part) => {
    const [id = '', from = '0'] = part.split(':');
    return { id, offset: Number(from) || 0, file: `${RESULTS}/${id}/transcript.jsonl` };
  }).filter((f) => ID.test(f.id) && existsSync(f.file));
  let timer: ReturnType<typeof setInterval>;
  return new Response(
    new ReadableStream({
      start(ctrl) {
        const enc = new TextEncoder();
        let busy = false;
        const pump = async (live: boolean) => {
          if (busy) return;
          busy = true;
          try {
            for (const f of feeds) {
              const from = f.offset;
              const bytes = new Uint8Array(await Bun.file(f.file).slice(from).arrayBuffer());
              const end = bytes.lastIndexOf(10) + 1;
              f.offset += end;
              const batch = new TextDecoder().decode(bytes.subarray(0, end)).split('\n').flatMap(items);
              // The first message of each run always goes out, so the page knows it has caught up
              if (batch.length || !live)
                ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ run: f.id, at: live ? Date.now() : null, from, to: f.offset, items: batch })}\n\n`));
            }
          } catch {
            // the stream was closed
          } finally {
            busy = false;
          }
        };
        pump(false);
        timer = setInterval(() => pump(true), 1000);
      },
      cancel() {
        clearInterval(timer);
      },
    }),
    { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } },
  );
}

const page = new URL('./index.html', import.meta.url).pathname;
const server = Bun.serve({
  port: Number(process.env.PORT ?? 4520),
  hostname: '127.0.0.1',
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const id = url.searchParams.get('run') ?? '';
    if (url.pathname === '/') return new Response(Bun.file(page));
    if (/^\/fonts\/bricolage-grotesque-latin(-ext)?\.woff2$/.test(url.pathname))
      return new Response(Bun.file(`${REPO}/spec/mockup/${url.pathname.slice(7)}`));
    if (url.pathname === '/api/runs') return Response.json(await listRuns());
    if (url.pathname === '/api/events') return events(url.searchParams.get('runs') ?? '');
    if (!ID.test(id) || !existsSync(`${RESULTS}/${id}/transcript.jsonl`)) return new Response('unknown run', { status: 404 });
    if (url.pathname === '/api/state') return Response.json(await state(id));
    return new Response('not found', { status: 404 });
  },
});
console.log(`live view on ${server.url}`);
