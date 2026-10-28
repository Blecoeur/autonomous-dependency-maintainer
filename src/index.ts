export { loadConfig, type LoadResult } from './config/load.js';
export { validateConfig, type ValidationError, type ValidationResult } from './config/validate.js';
export {
  DEFAULT_FORBIDDEN_PATHS,
  NODE_PNPM_DEPENDENCY_FILE_PATHS,
  PROTECTED_MANIFEST_KEYS,
  SCHEMA_VERSION,
  defaultConfig,
  type MaintenanceConfig,
} from './config/schema.js';
export { evaluatePr } from './policy/eligibility.js';
export { parseDependabotTitle } from './policy/dependabot.js';
export { guardManifests } from './policy/manifests.js';
export { matchesAny, matchedPatterns } from './policy/paths.js';
export {
  compareVersions,
  isVersion,
  nextSourceAwareVersion,
  parseVersion,
  updateType,
} from './policy/semver.js';
export { DECISION_EXIT_CODES, normalizeAuthorLogin, type Decision, type PolicyDecision, type PrInput } from './policy/pr.js';
export { adapterFor, type EcosystemAdapter, NodePnpmAdapter } from './providers/ecosystem-node-pnpm/adapter.js';
export {
  assembleReleasePlan,
  RELEASE_PROVENANCE_WARNING,
  type ClassifiedPr,
  type MergedPr,
  type PrKind,
  type ProvenanceDoc,
  type ReleaseInputData,
  type ReleasePlan,
} from './release/plan.js';
export {
  evaluateRepairEligibility,
  type CiRunFacts,
  type RepairEligibilityDecision,
  type RepairEligibilityInput,
  type RepairEligibilityReason,
  type RepairStateFacts,
} from './policy/repair-eligibility.js';
export type { RepairProvider } from './providers/repair/provider.js';
export {
  idempotencyKey,
  REPAIR_STRATEGY_VERSION,
  type RepairRequest,
  type RepairStatus,
  type RepairStatusReport,
} from './providers/repair/types.js';
export { MockRepairProvider } from './providers/repair/mock/adapter.js';
export { validatePatch, type PatchValidation, type ValidatePatchOptions } from './providers/repair/patch-validation.js';
export { VibeRepairProvider, type VibeRepairProviderOptions } from './providers/repair/vibe/provider.js';
export { buildRepairPrompt, repairSystemPrompt } from './providers/repair/vibe/prompt.js';
export {
  renderVibeConfig,
  writeVibeHome,
  DEFAULT_VIBE_CONFIG,
  REPAIR_SYSTEM_PROMPT_ID,
  type VibeRunConfig,
} from './providers/repair/vibe/config.js';
export { RepairWorkspace, scrubbedEnv, type CommandOutcome } from './providers/repair/vibe/sandbox.js';
