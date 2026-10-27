import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function withState(check: (dir: string, state: () => Promise<any>, get: (path: string) => Promise<Response>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'stackarena-live-test-'));
  const dir = `${root}/results/runs/backend-bun-1`;
  mkdirSync(`${root}/orchestrator/live`, { recursive: true });
  mkdirSync(`${dir}/session/subagents`, { recursive: true });
  mkdirSync(`${root}/runs/backend-bun-1`, { recursive: true });
  mkdirSync(`${root}/bin`);
  for (const file of ['server.ts']) cpSync(new URL(file, import.meta.url), `${root}/orchestrator/live/${file}`);
  for (const file of ['usage.ts', 'teams.json']) cpSync(new URL(`../${file}`, import.meta.url), `${root}/orchestrator/${file}`);
  for (const name of ['git', 'docker']) writeFileSync(`${root}/bin/${name}`, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(`${dir}/prompt.md`, 'fixture');
  writeFileSync(`${dir}/transcript.jsonl`, '');
  const serve = Bun.serve;
  const path = process.env.PATH;
  let fetchState: (req: Request) => Promise<Response>;
  try {
    process.env.PATH = `${root}/bin:${path}`;
    Bun.serve = ((options: any) => {
      fetchState = options.fetch;
      return { url: 'http://fixture/' };
    }) as unknown as typeof Bun.serve;
    await import(`${root}/orchestrator/live/server.ts`);
    Bun.serve = serve;
    const get = (path: string) => fetchState(new Request(`http://fixture${path}`));
    await check(dir, async () => (await get('/api/state?run=backend-bun-1')).json(), get);
  } finally {
    Bun.serve = serve;
    process.env.PATH = path;
    rmSync(root, { recursive: true, force: true });
  }
}

const toolResult = (text: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: text }] } }) + '\n';
const message = (id: string, input: number) => JSON.stringify({
  type: 'assistant', timestamp: '2026-10-25T12:00:00Z', message: { id, usage: { input_tokens: input } },
}) + '\n';

test('a failed-only Playwright result replaces the preceding green result', async () => {
  await withState(async (dir, state) => {
    writeFileSync(`${dir}/session/main.jsonl`, toolResult('2 passed (1s)') + toolResult('2 failed'));
    expect((await state()).tests).toMatchObject({ pass: 0, fail: 2 });
  });
});

test('nested session changes invalidate usage and the cost curve', async () => {
  await withState(async (dir, state) => {
    writeFileSync(`${dir}/session/main.jsonl`, message('main', 100_000));
    writeFileSync(`${dir}/session/subagents/child.jsonl`, message('child', 200_000));
    const before = await state();
    expect(before.usd).toBe(1.2);
    expect(before.series.at(-1).usd).toBe(1.2);
    writeFileSync(`${dir}/session/subagents/child.jsonl`, message('child', 400_000));
    const after = await state();
    expect(after.usd).toBe(2);
    expect(after.series.at(-1).usd).toBe(2);
  });
});

const text = (t: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } }) + '\n';
async function firstMessage(get: (path: string) => Promise<Response>, runs: string) {
  const reader = (await get(`/api/events?runs=${runs}`)).body!.getReader();
  const chunk = new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  return chunk.split('\n\n').filter(Boolean).map((m) => JSON.parse(m.slice('data: '.length)));
}

test('the event stream opens with each transcript even when it is still empty', async () => {
  await withState(async (_dir, _state, get) => {
    expect(await firstMessage(get, 'backend-bun-1:0,backend-none-1:0')).toEqual([{ run: 'backend-bun-1', at: null, from: 0, to: 0, items: [] }]);
  });
});

test('the event stream resumes at the offset and leaves an unfinished line for later', async () => {
  await withState(async (dir, _state, get) => {
    writeFileSync(`${dir}/transcript.jsonl`, text('first ä') + text('second') + '{"type":"assis');
    const offset = Buffer.byteLength(text('first ä'));
    expect(await firstMessage(get, `backend-bun-1:${offset}`)).toEqual([
      { run: 'backend-bun-1', at: null, from: offset, to: offset + Buffer.byteLength(text('second')), items: [{ k: 'text', text: 'second' }] },
    ]);
  });
});

test('a finished run counts as grading while its grade copy exists', async () => {
  await withState(async (dir, state) => {
    writeFileSync(`${dir}/summary.json`, JSON.stringify({ started: '2026-10-25T12:00:00Z' }));
    expect((await state()).grading).toBe(false);
    mkdirSync(`${dir}/../../../runs/backend-bun-1-grade`);
    expect((await state()).grading).toBe(true);
    writeFileSync(`${dir}/summary.json`, JSON.stringify({ started: '2026-10-25T12:00:00Z', grade: { score: 1 } }));
    expect((await state()).grading).toBe(false);
  });
});
