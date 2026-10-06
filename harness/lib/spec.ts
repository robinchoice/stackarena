import { readFileSync } from 'node:fs';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

// JSON Schemas from spec/openapi.yaml, so every harness part validates against the same contract.
// Plain node:fs keeps this usable from Bun and from Playwright, which runs on Node.
const doc = parse(readFileSync(new URL('../../spec/openapi.yaml', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(doc, 'openapi');

export type SchemaName =
  | 'Error'
  | 'Credentials'
  | 'User'
  | 'Session'
  | 'Habit'
  | 'CheckIn'
  | 'SyncRequest'
  | 'SyncResponse';

const cache = new Map<string, ValidateFunction>();
function compiled(name: SchemaName): ValidateFunction {
  let fn = cache.get(name);
  if (!fn) {
    fn = ajv.getSchema(`openapi#/components/schemas/${name}`);
    if (!fn) throw new Error(`Unknown schema ${name}`);
    cache.set(name, fn);
  }
  return fn;
}

// Returns null when valid, otherwise a readable list of problems.
export function problems(name: SchemaName, data: unknown): string | null {
  const fn = compiled(name);
  if (fn(data)) return null;
  return ajv.errorsText(fn.errors, { dataVar: name });
}

export function assertValid(name: SchemaName, data: unknown): void {
  const p = problems(name, data);
  if (p) throw new Error(p);
}
