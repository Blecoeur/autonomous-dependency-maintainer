import { parse } from 'yaml';
import { defaultConfig, type Ecosystem, type MaintenanceConfig } from './schema.js';
import { validateConfig, type ValidationError } from './validate.js';

export type LoadResult =
  | { ok: true; config: MaintenanceConfig }
  | { ok: false; errors: ValidationError[] };

/**
 * Load a `.maintenance.yml` document.
 *
 * Semantics: missing keys fall back to restrictive defaults; unknown keys or
 * values with the wrong type are hard errors. A config file that validates is
 * therefore fully explicit about everything it overrides.
 */
export function loadConfig(text: string): LoadResult {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (err) {
    return {
      ok: false,
      errors: [
        {
          path: '',
          message: `invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, errors: [{ path: '', message: 'config must be a mapping' }] };
  }

  const user = parsed as Record<string, unknown>;
  const projectName = user['project'];
  if (
    typeof projectName !== 'object' ||
    projectName === null ||
    typeof (projectName as Record<string, unknown>)['name'] !== 'string' ||
    ((projectName as Record<string, unknown>)['name'] as string).length === 0
  ) {
    return {
      ok: false,
      errors: [{ path: 'project.name', message: 'is required and must be a non-empty string' }],
    };
  }

  const name = (projectName as Record<string, unknown>)['name'] as string;
  const merged = deepMerge(
    defaultConfig(name, 'node-pnpm') as unknown as Json,
    user as unknown as Json,
  );

  const result = validateConfig(merged);
  if (result.ok) {
    return { ok: true, config: result.config };
  }
  return { ok: false, errors: result.errors };
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function deepMerge(base: Json, override: Json): Json {
  if (Array.isArray(base) || Array.isArray(override)) {
    // Arrays are replaced wholesale, never merged element-wise.
    return override;
  }
  if (
    typeof base === 'object' &&
    base !== null &&
    typeof override === 'object' &&
    override !== null
  ) {
    const out: { [key: string]: Json } = { ...(base as { [key: string]: Json }) };
    for (const [key, value] of Object.entries(override as { [key: string]: Json })) {
      if (value === undefined) {
        continue;
      }
      out[key] = key in out ? deepMerge(out[key] as Json, value) : value;
    }
    return out;
  }
  return override;
}
