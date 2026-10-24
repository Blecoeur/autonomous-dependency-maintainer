import type { MaintenanceConfig } from '../../config/schema.js';

/**
 * Ecosystem adapter contract. Phase 1 ships node-pnpm; other ecosystems
 * (python-poetry, go, ...) implement the same interface later.
 */
export interface EcosystemAdapter {
  /** Glob patterns of files a pure dependency PR may touch. */
  dependencyFilePaths(): string[];
}

export class NodePnpmAdapter implements EcosystemAdapter {
  constructor(private readonly config: MaintenanceConfig) {}

  dependencyFilePaths(): string[] {
    return [
      'package.json',
      '**/package.json',
      'pnpm-lock.yaml',
      '**/pnpm-lock.yaml',
    ];
  }
}

export function adapterFor(config: MaintenanceConfig): EcosystemAdapter {
  switch (config.project.ecosystem) {
    case 'node-pnpm':
      return new NodePnpmAdapter(config);
    default:
      throw new Error(`unsupported ecosystem: ${config.project.ecosystem satisfies never}`);
  }
}
