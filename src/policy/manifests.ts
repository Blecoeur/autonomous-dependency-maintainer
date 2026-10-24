import { PROTECTED_MANIFEST_KEYS } from '../config/schema.js';
import type { ManifestSnapshot } from './pr.js';

export interface ManifestGuardResult {
  /** Protected keys whose content differs between the two snapshots. */
  changedProtectedKeys: string[];
  /** Manifest paths that were added or removed by the PR. */
  addedOrRemoved: string[];
}

function parseManifest(text: string | null): Record<string, unknown> | null {
  if (text === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function differs(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) !== JSON.stringify(sortKeys(b));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Compares manifest snapshots and reports changes to protected sections.
 *
 * Rationale (spec 5.4): a PR can neutralize tests not only by editing test
 * files but by editing `scripts` in package.json — e.g. making `test` a no-op.
 * Manifest diffs are therefore checked structurally, not by path name alone.
 * Invalid JSON in a snapshot counts as a protected change: we never guess.
 */
export function guardManifests(snapshots: ManifestSnapshot[]): ManifestGuardResult {
  const changedProtectedKeys: string[] = [];
  const addedOrRemoved: string[] = [];

  for (const snapshot of snapshots) {
    const before = parseManifest(snapshot.before);
    const after = parseManifest(snapshot.after);

    if (before === null || after === null) {
      if (snapshot.before !== null || snapshot.after !== null) {
        // File added, removed, or unparseable: a dependency update never does this.
        addedOrRemoved.push(snapshot.path);
      }
      continue;
    }

    for (const key of PROTECTED_MANIFEST_KEYS) {
      if (differs(before[key], after[key])) {
        changedProtectedKeys.push(`${snapshot.path}#${key}`);
      }
    }
  }

  return { changedProtectedKeys, addedOrRemoved };
}
