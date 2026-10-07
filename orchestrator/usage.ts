import { existsSync, readFileSync, readdirSync } from 'node:fs';

// List prices in $ per million tokens for claude-opus-5-5; subscription runs are valued at these
export const PRICE = { input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 };
export type Tokens = Record<keyof typeof PRICE, number>;

// Token use of a run. The session files Claude Code keeps in the container hold the final usage of
// every API message, subagents included; the stream-json transcript only has values from the start
// of each message, so it is the fallback when no session copy exists.
export function usage(outDir: string): { requests: number; tokens: Tokens; usd: number; source: string } {
  const sessionDir = `${outDir}/session`;
  const files = existsSync(sessionDir)
    ? (readdirSync(sessionDir, { recursive: true }) as string[])
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => `${sessionDir}/${f}`)
    : [];
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
    tokens.input += u.input_tokens ?? 0;
    tokens.output += u.output_tokens ?? 0;
    tokens.cacheRead += u.cache_read_input_tokens ?? 0;
    const split = u.cache_creation ?? {};
    if (split.ephemeral_5m_input_tokens === undefined && split.ephemeral_1h_input_tokens === undefined)
      tokens.cacheWrite5m += u.cache_creation_input_tokens ?? 0;
    tokens.cacheWrite5m += split.ephemeral_5m_input_tokens ?? 0;
    tokens.cacheWrite1h += split.ephemeral_1h_input_tokens ?? 0;
  }
  const usd = (Object.keys(PRICE) as (keyof Tokens)[]).reduce((s, k) => s + (tokens[k] * PRICE[k]) / 1e6, 0);
  return { requests: messages.size, tokens, usd, source };
}
