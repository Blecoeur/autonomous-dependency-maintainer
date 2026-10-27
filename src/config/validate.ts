import type {
  Ecosystem,
  GroupingMode,
  MajorPolicy,
  MaintenanceConfig,
  MergeMode,
  MergeStrategy,
  RepairProviderName,
  UpdateSchedule,
  VersioningMode,
} from './schema.js';
import { SCHEMA_VERSION } from './schema.js';

export interface ValidationError {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; config: MaintenanceConfig }
  | { ok: false; errors: ValidationError[] };

const ECOSYSTEMS: Ecosystem[] = ['node-pnpm'];
const SCHEDULES: UpdateSchedule[] = ['weekly'];
const GROUPINGS: GroupingMode[] = ['individual', 'groups'];
const MAJOR_POLICIES: MajorPolicy[] = ['defer', 'allow'];
const MERGE_MODES: MergeMode[] = ['github-auto-merge'];
const MERGE_STRATEGIES: MergeStrategy[] = ['squash', 'merge', 'rebase'];
const VERSIONING_MODES: VersioningMode[] = ['source-aware', 'semver'];
const REPAIR_PROVIDERS: RepairProviderName[] = ['vibe', 'none', 'mock'];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

/**
 * Hand-rolled strict validator: unknown keys and wrong types are errors, so a
 * typo in `.maintenance.yml` fails loudly instead of silently reverting to a
 * default. A dedicated schema library is deliberately avoided to keep the
 * trusted dependency surface minimal.
 */
export function validateConfig(input: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  if (!isObject(input)) {
    return { ok: false, errors: [{ path: '', message: 'config must be a mapping' }] };
  }

  const root = input;

  // schema_version
  if (root['schema_version'] !== SCHEMA_VERSION) {
    errors.push({
      path: 'schema_version',
      message: `must be exactly ${SCHEMA_VERSION}`,
    });
  }

  // project
  const project = root['project'];
  if (!isObject(project)) {
    errors.push({ path: 'project', message: 'must be a mapping' });
  } else {
    const name = project['name'];
    if (!isString(name) || name.length === 0) {
      errors.push({ path: 'project.name', message: 'must be a non-empty string' });
    }
    const ecosystem = project['ecosystem'];
    if (!ECOSYSTEMS.includes(ecosystem as Ecosystem)) {
      errors.push({
        path: 'project.ecosystem',
        message: `must be one of: ${ECOSYSTEMS.join(', ')}`,
      });
    }
    const base = project['base_branch'];
    if (!isString(base) || !/^[A-Za-z0-9._/-]+$/.test(base)) {
      errors.push({ path: 'project.base_branch', message: 'must be a valid branch name' });
    }
    checkUnknownKeys(project, ['name', 'ecosystem', 'base_branch'], 'project', errors);
  }

  // updates
  const updates = root['updates'];
  if (!isObject(updates)) {
    errors.push({ path: 'updates', message: 'must be a mapping' });
  } else {
    expectEnum(updates['schedule'], SCHEDULES, 'updates.schedule', errors);
    expectInteger(updates['cooldown_days'], 'updates.cooldown_days', errors, { min: 0, max: 90 });
    expectInteger(updates['max_open_prs'], 'updates.max_open_prs', errors, { min: 1, max: 100 });
    expectEnum(updates['grouping'], GROUPINGS, 'updates.grouping', errors);
    expectBoolean(updates['allow_minor'], 'updates.allow_minor', errors);
    expectBoolean(updates['allow_patch'], 'updates.allow_patch', errors);

    const major = updates['major'];
    if (!isObject(major)) {
      errors.push({ path: 'updates.major', message: 'must be a mapping' });
    } else {
      expectEnum(major['default'], MAJOR_POLICIES, 'updates.major.default', errors);
      expectBoolean(
        major['enable_maintenance_audit'],
        'updates.major.enable_maintenance_audit',
        errors,
      );
      expectBoolean(
        major['migrate_if_eol_verified'],
        'updates.major.migrate_if_eol_verified',
        errors,
      );
      expectBoolean(
        major['migrate_if_security_unpatched'],
        'updates.major.migrate_if_security_unpatched',
        errors,
      );
      checkUnknownKeys(
        major,
        ['default', 'enable_maintenance_audit', 'migrate_if_eol_verified', 'migrate_if_security_unpatched'],
        'updates.major',
        errors,
      );
    }
    checkUnknownKeys(
      updates,
      ['schedule', 'cooldown_days', 'max_open_prs', 'grouping', 'allow_minor', 'allow_patch', 'major'],
      'updates',
      errors,
    );
  }

  // validation
  const validation = root['validation'];
  if (!isObject(validation)) {
    errors.push({ path: 'validation', message: 'must be a mapping' });
  } else {
    expectString(validation['install'], 'validation.install', errors);
    expectStringOrNull(validation['build'], 'validation.build', errors);
    expectStringOrNull(validation['typecheck'], 'validation.typecheck', errors);
    expectStringOrNull(validation['test'], 'validation.test', errors);
    expectStringOrNull(validation['smoke'], 'validation.smoke', errors);
    expectStringArray(
      validation['required_checks'],
      'validation.required_checks',
      errors,
      { allowEmpty: false },
    );
    if (validation['test'] === null && validation['smoke'] === null) {
      errors.push({
        path: 'validation',
        message: 'at least one of validation.test or validation.smoke must be set',
      });
    }
    checkUnknownKeys(
      validation,
      ['install', 'build', 'typecheck', 'test', 'smoke', 'required_checks'],
      'validation',
      errors,
    );
  }

  // repair
  const repair = root['repair'];
  if (!isObject(repair)) {
    errors.push({ path: 'repair', message: 'must be a mapping' });
  } else {
    expectEnum(repair['provider'], REPAIR_PROVIDERS, 'repair.provider', errors);
    expectBoolean(repair['enabled'], 'repair.enabled', errors);
    expectInteger(repair['max_attempts'], 'repair.max_attempts', errors, { min: 1, max: 10 });
    expectInteger(
      repair['max_parallel_per_repo'],
      'repair.max_parallel_per_repo',
      errors,
      { min: 1, max: 10 },
    );
    expectInteger(
      repair['max_changed_application_files'],
      'repair.max_changed_application_files',
      errors,
      { min: 1, max: 100 },
    );
    expectBoolean(repair['preserve_public_api'], 'repair.preserve_public_api', errors);
    expectStringArray(repair['forbidden_paths'], 'repair.forbidden_paths', errors, {
      allowEmpty: false,
    });
    expectStringArray(repair['allowed_ai_paths'], 'repair.allowed_ai_paths', errors, {
      allowEmpty: true,
    });
    checkUnknownKeys(
      repair,
      [
        'provider',
        'enabled',
        'max_attempts',
        'max_parallel_per_repo',
        'max_changed_application_files',
        'preserve_public_api',
        'forbidden_paths',
        'allowed_ai_paths',
      ],
      'repair',
      errors,
    );
  }

  // merge
  const merge = root['merge'];
  if (!isObject(merge)) {
    errors.push({ path: 'merge', message: 'must be a mapping' });
  } else {
    expectEnum(merge['mode'], MERGE_MODES, 'merge.mode', errors);
    expectEnum(merge['strategy'], MERGE_STRATEGIES, 'merge.strategy', errors);
    expectStringArray(merge['allowed_authors'], 'merge.allowed_authors', errors, {
      allowEmpty: false,
    });
    expectStringArray(merge['ai_authors'], 'merge.ai_authors', errors, { allowEmpty: true });
    checkUnknownKeys(
      merge,
      ['mode', 'strategy', 'allowed_authors', 'ai_authors'],
      'merge',
      errors,
    );
  }

  // release
  const release = root['release'];
  if (!isObject(release)) {
    errors.push({ path: 'release', message: 'must be a mapping' });
  } else {
    expectString(release['schedule'], 'release.schedule', errors);
    expectEnum(release['versioning'], VERSIONING_MODES, 'release.versioning', errors);
    expectInteger(release['initial_major'], 'release.initial_major', errors, { min: 0, max: 99 });
    expectBoolean(release['publish_github_release'], 'release.publish_github_release', errors);
    expectBoolean(release['publish_ghcr'], 'release.publish_ghcr', errors);
    checkUnknownKeys(
      release,
      ['schedule', 'versioning', 'initial_major', 'publish_github_release', 'publish_ghcr'],
      'release',
      errors,
    );
  }

  checkUnknownKeys(
    root,
    ['schema_version', 'project', 'updates', 'validation', 'repair', 'merge', 'release'],
    '',
    errors,
  );

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // After strict validation, the input is structurally the config.
  return { ok: true, config: input as unknown as MaintenanceConfig };
}

function checkUnknownKeys(
  obj: Record<string, unknown>,
  known: string[],
  path: string,
  errors: ValidationError[],
): void {
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      errors.push({ path: path ? `${path}.${key}` : key, message: 'unknown key' });
    }
  }
}

function expectEnum(
  v: unknown,
  allowed: string[],
  path: string,
  errors: ValidationError[],
): void {
  if (!isString(v) || !allowed.includes(v)) {
    errors.push({ path, message: `must be one of: ${allowed.join(', ')}` });
  }
}

function expectBoolean(v: unknown, path: string, errors: ValidationError[]): void {
  if (typeof v !== 'boolean') {
    errors.push({ path, message: 'must be a boolean' });
  }
}

function expectString(v: unknown, path: string, errors: ValidationError[]): void {
  if (!isString(v) || v.length === 0) {
    errors.push({ path, message: 'must be a non-empty string' });
  }
}

function expectStringOrNull(v: unknown, path: string, errors: ValidationError[]): void {
  if (v !== null && (!isString(v) || v.length === 0)) {
    errors.push({ path, message: 'must be a non-empty string or null' });
  }
}

function expectStringArray(
  v: unknown,
  path: string,
  errors: ValidationError[],
  opts: { allowEmpty: boolean },
): void {
  if (!Array.isArray(v) || (!opts.allowEmpty && v.length === 0)) {
    errors.push({
      path,
      message: opts.allowEmpty
        ? 'must be an array of strings'
        : 'must be a non-empty array of strings',
    });
    return;
  }
  for (const item of v) {
    if (!isString(item) || item.length === 0) {
      errors.push({ path, message: 'must contain only non-empty strings' });
      return;
    }
  }
}

function expectInteger(
  v: unknown,
  path: string,
  errors: ValidationError[],
  bounds: { min: number; max: number },
): void {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < bounds.min || v > bounds.max) {
    errors.push({
      path,
      message: `must be an integer between ${bounds.min} and ${bounds.max}`,
    });
  }
}
