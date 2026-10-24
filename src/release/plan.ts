import type { MaintenanceConfig } from '../config/schema.js';
import { evaluatePr } from '../policy/eligibility.js';
import type { PrInput } from '../policy/pr.js';
import { nextSourceAwareVersion, parseVersion } from '../policy/semver.js';

/** A merged pull request, as collected from the GitHub API by the workflow. */
export interface MergedPr {
  number: number;
  title: string;
  author: string;
  authorIsBot: boolean;
  labels: string[];
  files: string[];
  mergedAt: string;
  mergeSha: string;
}

/** Everything the plan computation needs; assembled by the release workflow. */
export interface ReleaseInputData {
  /** Last published semver tag, e.g. "v3.2.1", or null when none exists. */
  last_tag: string | null;
  /** Full name of the repository being released, e.g. "owner/repo". */
  source_repo: string;
  /** The pinned framework reference that computed this release. */
  framework_ref: string;
  merged_prs: MergedPr[];
}

export type PrKind = 'dependencies-only' | 'ai-assisted' | 'direct';

export interface ClassifiedPr {
  number: number;
  kind: PrKind;
  author: string;
  title: string;
  url: string;
  mergeSha: string;
  dependencies: string[];
  ai_assisted: boolean;
}

export interface ProvenanceDoc {
  schema_version: string;
  distribution_version: string;
  source_repo: string;
  framework_ref: string;
  maintenance_mode: string;
  human_review: boolean;
  merged_prs: ClassifiedPr[];
}

export interface ReleasePlan {
  should_release: boolean;
  previous_version: string | null;
  new_version: string;
  includes_ai_assisted: boolean;
  classified_prs: ClassifiedPr[];
  release_notes_markdown: string;
  provenance: ProvenanceDoc;
}

export const RELEASE_PROVENANCE_WARNING =
  '**Experimental, automatically maintained distribution.** This project ' +
  'automatically updates dependencies and may include AI-generated ' +
  'compatibility fixes. All changes are checked by an automated CI pipeline, ' +
  'but passing tests do not guarantee functional compatibility, reliability, ' +
  'or security. There is no human review requirement for eligible automated ' +
  'updates. No warranty or support commitment is provided.';

/**
 * Computes the weekly release plan from merged-PR evidence.
 *
 * Classification reuses the policy engine (author identity, changed paths,
 * labels) — never manually-set labels alone. Versioning follows the
 * source-aware convention: PATCH for dependency-only releases, MINOR when at
 * least one AI-assisted fix is included, MAJOR never moves. A re-run with the
 * same input yields the same plan (deterministic, no clock reads).
 */
export function assembleReleasePlan(
  config: MaintenanceConfig,
  data: ReleaseInputData,
): ReleasePlan {
  if (config.release.versioning !== 'source-aware') {
    throw new Error(
      `release.versioning '${config.release.versioning}' is not implemented yet; ` +
        'only source-aware is supported in this version.',
    );
  }

  const previousVersion = data.last_tag
    ? data.last_tag.replace(/^v/, '')
    : `${config.release.initial_major}.0.0`;

  if (data.last_tag !== null && parseVersion(previousVersion) === null) {
    throw new Error(`last_tag '${data.last_tag}' is not a valid vX.Y.Z tag`);
  }

  const classified: ClassifiedPr[] = data.merged_prs.map((pr) => {
    const prInput: PrInput = {
      number: pr.number,
      title: pr.title,
      author: pr.author,
      authorIsBot: pr.authorIsBot,
      baseRef: config.project.base_branch,
      headSha: pr.mergeSha,
      labels: pr.labels,
      files: pr.files,
      securityUpdate: pr.labels.includes('security'),
    };
    const decision = evaluatePr(config, prInput);
    const kind: PrKind =
      decision.classification === 'dependencies-only'
        ? 'dependencies-only'
        : decision.classification === 'ai-assisted'
          ? 'ai-assisted'
          : 'direct';
    return {
      number: pr.number,
      kind,
      author: pr.author,
      title: pr.title,
      url: `https://github.com/${data.source_repo}/pull/${pr.number}`,
      mergeSha: pr.mergeSha,
      dependencies: decision.dependencyUpdates.map((u) => u.name),
      ai_assisted: kind === 'ai-assisted',
    };
  });

  const includesAi = classified.some((pr) => pr.ai_assisted);

  const next = nextSourceAwareVersion(previousVersion, includesAi);
  if (next === null) {
    throw new Error(`cannot compute the next version from '${previousVersion}'`);
  }

  const plan: ReleasePlan = {
    should_release: classified.length > 0,
    previous_version: data.last_tag === null ? null : previousVersion,
    new_version: next,
    includes_ai_assisted: includesAi,
    classified_prs: classified,
    release_notes_markdown: renderNotes(config, data, classified, next, includesAi),
    provenance: {
      schema_version: '1',
      distribution_version: next,
      source_repo: data.source_repo,
      framework_ref: data.framework_ref,
      maintenance_mode: config.repair.enabled
        ? 'automated-with-ai'
        : 'automated',
      human_review: false,
      merged_prs: classified,
    },
  };
  return plan;
}

function renderNotes(
  config: MaintenanceConfig,
  data: ReleaseInputData,
  classified: ClassifiedPr[],
  version: string,
  includesAi: boolean,
): string {
  const sections: string[] = [];

  const deps = classified.filter((p) => p.kind === 'dependencies-only');
  const ai = classified.filter((p) => p.kind === 'ai-assisted');
  const direct = classified.filter((p) => p.kind === 'direct');

  sections.push(
    `Automated maintenance release computed by the ` +
      `[autonomous-dependency-maintainer](${data.framework_ref}) framework.`,
  );
  sections.push('');

  sections.push('## What changed');
  if (deps.length > 0) {
    sections.push('');
    sections.push('### Dependency updates (no AI)');
    for (const pr of deps) sections.push(`- ${pr.title} ([#${pr.number}](${pr.url}))`);
  }
  if (ai.length > 0) {
    sections.push('');
    sections.push('### AI-assisted compatibility fixes');
    for (const pr of ai) sections.push(`- ${pr.title} ([#${pr.number}](${pr.url}))`);
  }
  if (direct.length > 0) {
    sections.push('');
    sections.push('### Direct changes');
    for (const pr of direct) sections.push(`- ${pr.title} ([#${pr.number}](${pr.url}))`);
  }

  sections.push('');
  sections.push('## Version');
  sections.push(
    includesAi
      ? `MINOR bump: this release contains at least one AI-assisted application fix.`
      : `PATCH bump: dependency-only release (no AI-assisted application changes).`,
  );

  sections.push('');
  sections.push('## Provenance');
  sections.push(
    `- Framework: ${data.framework_ref}`,
    `- Policy: \`${config.project.name}\`, mode \`${config.release.versioning}\``,
    `- Machine-readable provenance: \`provenance.json\` attached to this release`,
  );

  sections.push('');
  sections.push(`> ${RELEASE_PROVENANCE_WARNING}`);

  return sections.join('\n');
}
