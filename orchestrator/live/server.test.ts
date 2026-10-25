import { expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function withState(check: (dir: string, state: () => Promise<any>) => Promise<void>) {
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
    await check(dir, async () => (await fetchState(new Request('http://fixture/api/state?run=backend-bun-1'))).json());
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
