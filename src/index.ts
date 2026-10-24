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
export { DECISION_EXIT_CODES, type Decision, type PolicyDecision, type PrInput } from './policy/pr.js';
export { adapterFor, type EcosystemAdapter, NodePnpmAdapter } from './providers/ecosystem-node-pnpm/adapter.js';
