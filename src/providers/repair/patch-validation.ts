import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MaintenanceConfig } from '../../config/schema.js';
import { guardManifests } from '../../policy/manifests.js';
import { matchesAny } from '../../policy/paths.js';
import type { ManifestSnapshot } from '../../policy/pr.js';
import type { RepairRequest } from './types.js';

/**
 * Result of validating the patch an agent produced in the repair workspace.
 *
 * This is the framework-side enforcement point for the AI repair circuit
 * (spec 7.9): the agent's output is untrusted input. The same policy engine
 * that guards maintenance PRs re-evaluates the AI patch here — forbidden
 * paths, protected manifest sections, the allowed AI surface and the file
 * budget — before the gateway may open a replacement PR.
 */
export interface PatchValidation {
  allowed: boolean;
  /** Changed paths outside the dependency manifests (application files). */
  changed_application_files: string[];
  /** All changed paths, manifests included. */
  changed_files: string[];
  /** Human-readable violations; empty when allowed. */
  violations: string[];
}

export interface ValidatePatchOptions {
  /**
   * Absolute path of a pristine checkout of the PR head with only the
   * dependency update applied (no agent edits). The patch is the diff
   * between this baseline and the workspace.
   */
  baseline: string;
  /** Absolute path of the repair workspace (baseline + agent edits). */
  workspace: string;
  /** Dependency manifest/lockfile paths of the ecosystem (e.g. package.json). */
  dependencyFilePaths: string[];
}

interface ChangedFile {
  path: string;
  /** Content at the baseline side; null when the file was added. */
  before: string | null;
  /** Content at the workspace side; null when the file was removed. */
  after: string | null;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.turbo', 'coverage', '.next']);

/**
 * Validates an agent-produced patch against the repository policy:
 * - no forbidden path may change;
 * - package.json protected sections must be identical to the baseline;
 * - application changes must stay within repair.allowed_ai_paths;
 * - at most repair.max_changed_application_files application files change.
 */
export function validatePatch(
  config: MaintenanceConfig,
  request: RepairRequest,
  options: ValidatePatchOptions,
): PatchValidation {
  const changed = diffWorkspace(options.baseline, options.workspace);
  const violations: string[] = [];

  for (const file of changed) {
    if (matchesAny(file.path, config.repair.forbidden_paths)) {
      violations.push(`forbidden path changed: ${file.path}`);
    }
    if (file.path.startsWith('/') || file.path.split('/').includes('..') || /\s/.test(file.path)) {
      violations.push(`suspicious path: ${file.path}`);
    }
  }

  const manifestSnapshots: ManifestSnapshot[] = changed
    .filter((file) => /(^|\/)package\.json$/.test(file.path))
    .map((file) => ({ path: file.path, before: file.before, after: file.after }));
  const manifestGuard = guardManifests(manifestSnapshots);
  for (const key of manifestGuard.changedProtectedKeys) {
    violations.push(`protected manifest section changed: ${key}`);
  }
  for (const path of manifestGuard.addedOrRemoved) {
    violations.push(`manifest added/removed: ${path}`);
  }

  const changed_application_files = changed
    .map((file) => file.path)
    .filter((path) => !matchesAny(path, options.dependencyFilePaths));

  if (config.repair.allowed_ai_paths.length > 0) {
    const outside = changed_application_files.filter(
      (path) => !matchesAny(path, config.repair.allowed_ai_paths),
    );
    for (const path of outside) {
      violations.push(`path outside the allowed AI surface: ${path}`);
    }
  } else if (changed_application_files.length > 0) {
    violations.push('no repair.allowed_ai_paths configured; application-code repairs are blocked');
  }

  if (changed_application_files.length > config.repair.max_changed_application_files) {
    violations.push(
      `changed application files ${changed_application_files.length} exceeds the budget ` +
        `${config.repair.max_changed_application_files}`,
    );
  }

  return {
    allowed: violations.length === 0,
    changed_application_files,
    changed_files: changed.map((file) => file.path),
    violations,
  };
}

function diffWorkspace(baseline: string, workspace: string): ChangedFile[] {
  const paths = new Set<string>();
  for (const root of [baseline, workspace]) {
    for (const path of listFiles(root)) {
      paths.add(path);
    }
  }
  const changed: ChangedFile[] = [];
  for (const path of [...paths].sort()) {
    const before = readIfExists(join(baseline, path));
    const after = readIfExists(join(workspace, path));
    if (before !== after) {
      changed.push({ path, before, after });
    }
  }
  return changed;
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [''];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const absolute = dir === '' ? root : join(root, dir);
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          stack.push(rel);
        }
        continue;
      }
      out.push(rel);
    }
  }
  return out;
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
