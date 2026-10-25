import { existsSync, readFileSync, readdirSync } from 'node:fs';

// List prices in $ per million tokens for claude-opus-5-5. Runs with the API key pay these from the
// monthly API credits; subscription runs are valued at them
export const PRICE = { input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 };
export type Tokens = Record<keyof typeof PRICE, number>;
const KINDS = Object.keys(PRICE) as (keyof Tokens)[];

// The session files Claude Code kept in the container, subagents included. They hold the final
// usage of every API message; the stream-json transcript only has values from the start of each
// message, so it is the fallback when no session copy exists.
export function sessionFiles(outDir: string): string[] {
  const dir = `${outDir}/session`;
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.jsonl')).map((f) => `${dir}/${f}`);
}

// Tokens of one API message from its usage entry. Without the cache split, the whole cache write
// counts as a 5-minute write
export function tokensOf(u: Record<string, any>): Tokens {
  const split = u.cache_creation ?? {};
  const unsplit = split.ephemeral_5m_input_tokens === undefined && split.ephemeral_1h_input_tokens === undefined;
  return {
    input: u.input_tokens ?? 0,
    cacheWrite5m: (unsplit ? (u.cache_creation_input_tokens ?? 0) : 0) + (split.ephemeral_5m_input_tokens ?? 0),
    cacheWrite1h: split.ephemeral_1h_input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    output: u.output_tokens ?? 0,
  };
}

export const priceOf = (t: Tokens) => KINDS.reduce((s, k) => s + (t[k] * PRICE[k]) / 1e6, 0);

// Token use of a run
export function usage(outDir: string): { requests: number; tokens: Tokens; usd: number; source: string } {
  const files = sessionFiles(outDir);
  const source = files.length ? 'session' : 'transcript';
  if (!files.length) files.push(`${outDir}/transcript.jsonl`);

  const messages = new Map<string, Record<string, any>>();
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"usage"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.type === 'assistant' && e.message?.usage) messages.set(e.message.id, e.message.usage);
      } catch {}
    }
  }
  const tokens: Tokens = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
  for (const u of messages.values()) {
    const t = tokensOf(u);
    for (const k of KINDS) tokens[k] += t[k];
  }
  return { requests: messages.size, tokens, usd: priceOf(tokens), source };
}
