/**
 * Types and defaults for `.maintenance.yml`.
 *
 * This file is a contract owned by the framework. GitHub does not know about
 * it; the CLI and the reusable workflows consume it after validation.
 */

export type Ecosystem = 'node-pnpm';
export type UpdateSchedule = 'weekly';
export type GroupingMode = 'individual' | 'groups';
export type MajorPolicy = 'defer' | 'allow';
export type MergeMode = 'github-auto-merge';
export type MergeStrategy = 'squash' | 'merge' | 'rebase';
export type VersioningMode = 'source-aware' | 'semver';
export type RepairProviderName = 'mistral-workflows' | 'none' | 'mock';

export interface MajorConfig {
  /** Ordinary major updates are never merged automatically when 'defer'. */
  default: MajorPolicy;
  enable_maintenance_audit: boolean;
  migrate_if_eol_verified: boolean;
  migrate_if_security_unpatched: boolean;
}

export interface UpdatesConfig {
  schedule: UpdateSchedule;
  cooldown_days: number;
  max_open_prs: number;
  grouping: GroupingMode;
  allow_minor: boolean;
  allow_patch: boolean;
  major: MajorConfig;
}

export interface ValidationConfig {
  install: string;
  build: string | null;
  typecheck: string | null;
  test: string | null;
  smoke: string | null;
  required_checks: string[];
}

export interface RepairConfig {
  provider: RepairProviderName;
  enabled: boolean;
  max_attempts: number;
  max_parallel_per_repo: number;
  max_changed_application_files: number;
  preserve_public_api: boolean;
  /** Glob patterns that no automated change may ever touch. */
  forbidden_paths: string[];
  /**
   * Glob patterns describing application code an AI repair may modify.
   * Restrictive by default; extend per repository after review.
   */
  allowed_ai_paths: string[];
}

export interface MergeConfig {
  mode: MergeMode;
  strategy: MergeStrategy;
  /** Bot logins authorized to open automergeable maintenance PRs. */
  allowed_authors: string[];
  /** Bot logins of AI repair PR authors (GitHub App bot identity). */
  ai_authors: string[];
}

export interface ReleaseConfig {
  schedule: string;
  versioning: VersioningMode;
  initial_major: number;
  publish_github_release: boolean;
  publish_ghcr: boolean;
}

export interface ProjectConfig {
  name: string;
  ecosystem: Ecosystem;
  base_branch: string;
}

export interface MaintenanceConfig {
  schema_version: number;
  project: ProjectConfig;
  updates: UpdatesConfig;
  validation: ValidationConfig;
  repair: RepairConfig;
  merge: MergeConfig;
  release: ReleaseConfig;
}

export const SCHEMA_VERSION = 1 as const;

/**
 * Restrictive defaults, per the spec: anything ambiguous is blocked, not
 * allowed. Consumer repositories opt in to more permissive values explicitly.
 */
export const DEFAULT_FORBIDDEN_PATHS: string[] = [
  '.github/**',
  '.maintenance.yml',
  'CODEOWNERS',
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/__snapshots__/**',
  '**/*.snap',
  '**/*.snap.*',
];

/**
 * Manifest and lockfile paths a pure dependency PR may modify in the
 * node-pnpm ecosystem. Anything outside this set disqualifies the
 * `dependencies-only` classification.
 */
export const NODE_PNPM_DEPENDENCY_FILE_PATHS: string[] = [
  'package.json',
  '**/package.json',
  'pnpm-lock.yaml',
  '**/pnpm-lock.yaml',
];

/**
 * Keys of package.json that a pure dependency update never needs to change.
 * Touching any of these disqualifies the PR (e.g. removing the test script).
 */
export const PROTECTED_MANIFEST_KEYS: string[] = [
  'scripts',
  'lint-staged',
  'husky',
  'simple-git-hooks',
  'pre-commit',
];

export function defaultConfig(projectName: string, ecosystem: Ecosystem): MaintenanceConfig {
  return {
    schema_version: SCHEMA_VERSION,
    project: {
      name: projectName,
      ecosystem,
      base_branch: 'main',
    },
    updates: {
      schedule: 'weekly',
      cooldown_days: 3,
      max_open_prs: 20,
      grouping: 'individual',
      allow_minor: true,
      allow_patch: true,
      major: {
        default: 'defer',
        enable_maintenance_audit: true,
        migrate_if_eol_verified: false,
        migrate_if_security_unpatched: true,
      },
    },
    validation: {
      install: 'pnpm install --frozen-lockfile',
      build: 'pnpm build',
      typecheck: null,
      test: 'pnpm test',
      smoke: null,
      required_checks: ['dependency-ci', 'maintenance-policy'],
    },
    repair: {
      provider: 'mistral-workflows',
      enabled: true,
      max_attempts: 3,
      max_parallel_per_repo: 1,
      max_changed_application_files: 10,
      preserve_public_api: true,
      forbidden_paths: [...DEFAULT_FORBIDDEN_PATHS],
      allowed_ai_paths: [],
    },
    merge: {
      mode: 'github-auto-merge',
      strategy: 'squash',
      allowed_authors: ['dependabot[bot]'],
      ai_authors: [],
    },
    release: {
      schedule: 'weekly-sunday',
      versioning: 'source-aware',
      initial_major: 3,
      publish_github_release: true,
      publish_ghcr: false,
    },
  };
}
