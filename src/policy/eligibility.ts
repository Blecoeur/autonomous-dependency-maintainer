import type { MaintenanceConfig } from '../config/schema.js';
import { INFRASTRUCTURE_UPDATE_PATHS } from '../config/schema.js';
import { parseDependabotTitle } from './dependabot.js';
import { guardManifests } from './manifests.js';
import { matchesAny, matchedPatterns } from './paths.js';
import type {
  Classification,
  DecisionReasonCode,
  DependencyUpdate,
  PolicyDecision,
  PrInput,
} from './pr.js';
import { adapterFor } from '../providers/ecosystem-node-pnpm/adapter.js';

const AI_ASSISTED_LABEL = 'ai-assisted';

/**
 * The decision core of the framework: given a validated configuration and
 * the PR facts collected from GitHub, decide whether the PR is an eligible
 * automated maintenance PR that GitHub native auto-merge may merge.
 *
 * Design rules enforced here (spec 5.2, 5.4, 12.1):
 * - Labels never grant eligibility; only the author identity does.
 * - Unknown or ambiguous situations block (needs-human / rejected), they are
 *   never silently treated as eligible.
 * - The engine is deterministic and never calls any network or LLM.
 */
export function evaluatePr(config: MaintenanceConfig, pr: PrInput): PolicyDecision {
  const reasons: DecisionReasonCode[] = [];
  const details: string[] = [];
  const updates = resolveUpdates(pr);
  const adapter = adapterFor(config);

  // 1. Base branch must match the configured target.
  if (pr.baseRef !== config.project.base_branch) {
    reasons.push('wrong-base-branch');
    details.push(
      `PR targets '${pr.baseRef}' but this repository maintains '${config.project.base_branch}'.`,
    );
    return build('not-maintenance', 'none', reasons, details, updates);
  }

  const isDependencyBot = config.merge.allowed_authors.includes(pr.author);
  const isAiBot = config.merge.ai_authors.includes(pr.author);

  // 2. Only recognized bot authors can be maintenance PRs. A human PR that
  // merely carries maintenance labels is ignored entirely.
  if (!isDependencyBot && !isAiBot) {
    reasons.push('author-not-authorized');
    details.push(
      `Author '${pr.author}' is not in the configured maintenance author list; ` +
        'labels do not grant eligibility.',
    );
    return build('not-maintenance', 'none', reasons, details, updates);
  }

  // Infrastructure-only updates (e.g. Dependabot's github-actions ecosystem)
  // modify the trust engine itself. They are legitimate maintenance but are
  // merged by human decision only: green check, visible, never auto-merged.
  // A PR mixing infrastructure with anything else stays a hard rejection.
  if (
    isDependencyBot &&
    pr.files.length > 0 &&
    pr.files.every((file) => matchesAny(file, INFRASTRUCTURE_UPDATE_PATHS))
  ) {
    reasons.push('infrastructure-update-needs-human');
    details.push(
      'This maintenance PR updates CI/Actions infrastructure; infrastructure ' +
        'changes are merged by human decision only and are never auto-merged.',
    );
    return build('needs-human', 'none', reasons, details, updates);
  }

  // 3. Forbidden paths reject any maintenance PR, regardless of circuit.
  const forbiddenHits = pr.files.filter((file) =>
    matchesAny(file, config.repair.forbidden_paths),
  );
  if (forbiddenHits.length > 0) {
    reasons.push('forbidden-path-changed');
    details.push(
      `PR modifies protected paths: ${forbiddenHits.join(', ')} ` +
        `(matched: ${matchedPatterns(forbiddenHits[0] as string, config.repair.forbidden_paths).join(', ')}).`,
    );
    return build('rejected', 'none', reasons, details, updates);
  }

  // 4. Protected manifest sections must be untouched.
  const manifestGuard = guardManifests(pr.manifests ?? []);
  if (
    manifestGuard.changedProtectedKeys.length > 0 ||
    manifestGuard.addedOrRemoved.length > 0
  ) {
    reasons.push('protected-manifest-section-changed');
    details.push(
      `Protected manifest sections changed: ${manifestGuard.changedProtectedKeys.join(', ')}; ` +
        `manifests added/removed: ${manifestGuard.addedOrRemoved.join(', ')}.`,
    );
    return build('rejected', 'none', reasons, details, updates);
  }

  if (isDependencyBot) {
    return evaluateDependencyBotPr(config, pr, updates, reasons, details, adapter);
  }
  return evaluateAiPr(config, pr, updates, reasons, details, adapter);
}

function evaluateDependencyBotPr(
  config: MaintenanceConfig,
  pr: PrInput,
  updates: DependencyUpdate[],
  reasons: DecisionReasonCode[],
  details: string[],
  adapter: ReturnType<typeof adapterFor>,
): PolicyDecision {
  // A pure dependency PR may only touch manifest/lockfile files.
  const unexpected = pr.files.filter(
    (file) => !matchesAny(file, adapter.dependencyFilePaths()),
  );
  if (unexpected.length > 0) {
    reasons.push('unexpected-file-changes');
    details.push(
      `Dependency PR modifies files outside manifests/lockfiles: ${unexpected.join(', ')}.`,
    );
    return build('rejected', 'none', reasons, details, updates);
  }

  if (updates.length === 0) {
    reasons.push('update-type-unverified');
    details.push(
      'No dependency movement could be parsed from this PR; refusing to classify it automatically.',
    );
    return build('needs-human', 'dependencies-only', reasons, details, updates);
  }

  for (const update of updates) {
    if (update.updateType === 'major') {
      if (pr.securityUpdate === true) {
        // Security majors bypass Dependabot's cooldown but still need a human
        // decision in the MVP; the major-audit circuit (P1) may automate this.
        reasons.push('major-requires-policy-authorization');
        details.push(
          `Security update of '${update.name}' crosses a major version ` +
            `(${update.fromVersion} -> ${update.toVersion}); requires explicit policy authorization.`,
        );
        return build('needs-human', 'dependencies-only', reasons, details, updates);
      }
      reasons.push('major-deferred');
      details.push(
        `Update of '${update.name}' crosses a major version ` +
          `(${update.fromVersion} -> ${update.toVersion}); major updates are deferred by policy.`,
      );
      return build('needs-human', 'dependencies-only', reasons, details, updates);
    }
    if (update.updateType === 'minor' && !config.updates.allow_minor) {
      reasons.push('update-type-not-allowed');
      details.push(`Minor updates are disabled in this repository's policy.`);
      return build('needs-human', 'dependencies-only', reasons, details, updates);
    }
    if (update.updateType === 'patch' && !config.updates.allow_patch) {
      reasons.push('update-type-not-allowed');
      details.push(`Patch updates are disabled in this repository's policy.`);
      return build('needs-human', 'dependencies-only', reasons, details, updates);
    }
  }

  return build('eligible', 'dependencies-only', reasons, details, updates);
}

function evaluateAiPr(
  config: MaintenanceConfig,
  pr: PrInput,
  updates: DependencyUpdate[],
  reasons: DecisionReasonCode[],
  details: string[],
  adapter: ReturnType<typeof adapterFor>,
): PolicyDecision {
  if (!config.repair.enabled) {
    reasons.push('ai-repair-disabled');
    details.push('AI repairs are disabled in this repository; the PR needs human review.');
    return build('needs-human', 'ai-assisted', reasons, details, updates);
  }

  // Author identity is verified by the caller (workflow, from GitHub data);
  // the label is a provenance requirement on top of it, not a substitute.
  if (!pr.labels.includes(AI_ASSISTED_LABEL)) {
    reasons.push('missing-ai-label');
    details.push(`AI repair PR must carry the '${AI_ASSISTED_LABEL}' label.`);
    return build('needs-human', 'ai-assisted', reasons, details, updates);
  }

  // Major updates inside an AI repair need a prior, verifiable policy
  // authorization (EOL or unpatched security). Not implemented in Phase 1.
  if (updates.some((u) => u.updateType === 'major')) {
    reasons.push('major-requires-policy-authorization');
    details.push(
      'The repaired update crosses a major version; the major-audit circuit must authorize it first.',
    );
    return build('needs-human', 'ai-assisted', reasons, details, updates);
  }

  const applicationFiles = pr.files.filter(
    (file) => !matchesAny(file, adapter.dependencyFilePaths()),
  );

  if (applicationFiles.length > config.repair.max_changed_application_files) {
    reasons.push('too-many-application-files');
    details.push(
      `AI repair modifies ${applicationFiles.length} application files; ` +
        `policy allows at most ${config.repair.max_changed_application_files}.`,
    );
    return build('rejected', 'ai-assisted', reasons, details, updates);
  }

  // When allowed_ai_paths is configured, application changes must stay within it.
  if (config.repair.allowed_ai_paths.length > 0) {
    const outside = applicationFiles.filter(
      (file) => !matchesAny(file, config.repair.allowed_ai_paths),
    );
    if (outside.length > 0) {
      reasons.push('ai-path-not-allowed');
      details.push(
        `AI repair modifies paths outside the allowed application surface: ${outside.join(', ')}.`,
      );
      return build('rejected', 'ai-assisted', reasons, details, updates);
    }
  } else if (applicationFiles.length > 0) {
    // No application surface has been reviewed for this repository yet.
    reasons.push('ai-path-not-allowed');
    details.push(
      'This repository has not declared repair.allowed_ai_paths; ' +
        'application-code repairs are blocked until it does.',
    );
    return build('rejected', 'ai-assisted', reasons, details, updates);
  }

  return build('eligible', 'ai-assisted', reasons, details, updates);
}

function resolveUpdates(pr: PrInput): DependencyUpdate[] {
  if (pr.dependencyUpdates !== undefined) {
    return pr.dependencyUpdates;
  }
  return parseDependabotTitle(pr.title);
}

function build(
  decision: PolicyDecision['decision'],
  classification: Classification,
  reasons: DecisionReasonCode[],
  details: string[],
  dependencyUpdates: DependencyUpdate[],
): PolicyDecision {
  return {
    decision,
    classification,
    reasons,
    details,
    automerge: decision === 'eligible',
    dependencyUpdates,
  };
}
