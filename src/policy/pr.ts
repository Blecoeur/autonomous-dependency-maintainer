import type { UpdateType } from './semver.js';

/** One dependency movement carried by a maintenance PR. */
export interface DependencyUpdate {
  name: string;
  fromVersion: string;
  toVersion: string;
  updateType: UpdateType;
}

/**
 * Raw snapshot of a manifest before/after the PR, used to verify that a
 * dependency update did not silently alter protected sections such as
 * `scripts`. `null` means the file did not exist on that side.
 */
export interface ManifestSnapshot {
  path: string;
  before: string | null;
  after: string | null;
}

/**
 * Everything the policy engine needs to decide about one PR. The GitHub
 * workflow collects this via the GitHub API (`gh`); the engine itself never
 * holds a token and stays a pure function.
 */
export interface PrInput {
  number: number;
  title: string;
  /** Author login, e.g. `dependabot[bot]` or the GitHub App bot login. */
  author: string;
  authorIsBot: boolean;
  baseRef: string;
  headSha: string;
  labels: string[];
  /** Changed file paths of the PR. */
  files: string[];
  /**
   * Parsed dependency movements. When absent, the engine tries to derive
   * them from the Dependabot PR title.
   */
  dependencyUpdates?: DependencyUpdate[];
  /** True when the PR is a Dependabot security update (label-derived). */
  securityUpdate?: boolean;
  /** package.json snapshots for protected-section comparison. */
  manifests?: ManifestSnapshot[];
}

export type Decision = 'eligible' | 'not-maintenance' | 'rejected' | 'needs-human';

export type Classification = 'dependencies-only' | 'ai-assisted' | 'none';

export type DecisionReasonCode =
  | 'wrong-base-branch'
  | 'author-not-authorized'
  | 'forbidden-path-changed'
  | 'unexpected-file-changes'
  | 'protected-manifest-section-changed'
  | 'major-deferred'
  | 'update-type-not-allowed'
  | 'update-type-unverified'
  | 'missing-ai-label'
  | 'ai-path-not-allowed'
  | 'too-many-application-files'
  | 'ai-repair-disabled'
  | 'major-requires-policy-authorization'
  | 'no-config-on-base'
  | 'infrastructure-update-needs-human';

export interface PolicyDecision {
  decision: Decision;
  classification: Classification;
  /** Stable machine-readable reason codes. */
  reasons: DecisionReasonCode[];
  /** Human-readable explanations, one per reason. */
  details: string[];
  /** True only when the PR may be auto-merged by GitHub. */
  automerge: boolean;
  dependencyUpdates: DependencyUpdate[];
}

export const DECISION_EXIT_CODES: Record<Decision, number> = {
  eligible: 0,
  'not-maintenance': 0,
  'needs-human': 0,
  rejected: 1,
};
