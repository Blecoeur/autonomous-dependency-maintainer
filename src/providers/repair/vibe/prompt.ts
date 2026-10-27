import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { MaintenanceConfig } from '../../../config/schema.js';
import type { RepairRequest } from '../types.js';

/**
 * The repair doctrine, injected as the vibe system prompt.
 *
 * The doctrine lives in `src/providers/repair/skill/dependency-repair.md` —
 * a reviewable artifact, not code. Enforcement is external (policy engine +
 * independent re-verification), never prompt-only.
 *
 * The file is a runtime asset, not compiled output: it is resolved relative
 * to this module and falls back to the source tree, so the CLI works from
 * both `dist/` (published package ships `skill/` next to `dist/`) and a
 * source checkout.
 */
function resolveSkillPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'skill', 'dependency-repair.md'),
    join(here, '..', '..', '..', '..', 'src', 'providers', 'repair', 'skill', 'dependency-repair.md'),
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return candidates[0] as string;
}

const SKILL_PATH = resolveSkillPath();

export function repairSystemPrompt(): string {
  return readFileSync(SKILL_PATH, 'utf8');
}

export function buildRepairPrompt(
  config: MaintenanceConfig,
  request: RepairRequest,
  failureTail: string,
): string {
  const updates = request.dependency_updates
    .map((u) => `${u.name} ${u.from_version} -> ${u.to_version} (${u.update_type})`)
    .join(', ');
  const oracle = [request.commands.build, request.commands.test].filter(Boolean).join(' && ');
  return [
    `Repository: ${request.repository} (head ${request.original_head_sha}).`,
    `Dependency update under repair: ${updates}.`,
    `Verification oracle: ${oracle}.`,
    `Budget: at most ${request.policy.max_changed_application_files} changed application files.`,
    '',
    'The repository is checked out in the current working directory, the update is',
    'already applied and dependencies are installed. Verification currently fails:',
    '```',
    failureTail,
    '```',
    '',
    'Find the precise cause, apply the minimal fix, and re-run the verification',
    'until it passes. Never touch tests, snapshots, CI workflows, test',
    'configuration, quality/security rules, release files, .maintenance.yml,',
    'CODEOWNERS or the scripts section of any package.json. If the fix requires',
    'a forbidden change, stop and report BLOCKED with the precise technical',
    'reason — an honest BLOCKED is a success, a misleading patch is a failure.',
    '',
    `Allowed application surface: ${
      config.repair.allowed_ai_paths.length > 0
        ? config.repair.allowed_ai_paths.join(', ')
        : '(none configured — application changes will be rejected)'
    }.`,
  ].join('\n');
}
