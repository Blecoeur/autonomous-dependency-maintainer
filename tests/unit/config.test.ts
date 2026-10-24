import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { validateConfig } from '../../src/config/validate.js';
import { defaultConfig } from '../../src/config/schema.js';

const MINIMAL = `
schema_version: 1
project:
  name: demo-repo
`;

describe('loadConfig', () => {
  it('fills restrictive defaults from a minimal file', () => {
    const result = loadConfig(MINIMAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.project.ecosystem).toBe('node-pnpm');
    expect(result.config.project.base_branch).toBe('main');
    expect(result.config.updates.cooldown_days).toBe(3);
    expect(result.config.updates.max_open_prs).toBe(20);
    expect(result.config.updates.major.default).toBe('defer');
    expect(result.config.merge.allowed_authors).toEqual(['dependabot[bot]']);
    expect(result.config.repair.forbidden_paths).toContain('.github/**');
    expect(result.config.repair.max_attempts).toBe(3);
  });

  it('applies explicit overrides without touching other defaults', () => {
    const result = loadConfig(`
schema_version: 1
project:
  name: demo-repo
updates:
  cooldown_days: 7
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.updates.cooldown_days).toBe(7);
    expect(result.config.updates.max_open_prs).toBe(20);
  });

  it('requires project.name', () => {
    const result = loadConfig('schema_version: 1');
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.path === 'project.name')).toBe(true);
  });

  it('rejects invalid YAML', () => {
    const result = loadConfig('::::not yaml');
    expect(result.ok).toBe(false);
  });

  it('rejects non-mapping documents', () => {
    const result = loadConfig('- a\n- b\n');
    expect(result.ok).toBe(false);
  });
});

describe('validateConfig', () => {
  it('rejects unknown keys at any level', () => {
    const result = loadConfig(`
schema_version: 1
project:
  name: demo-repo
  ecosystem: node-pnpm
  base_branch: main
totally_new_section: {}
`);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.path === 'totally_new_section')).toBe(true);
  });

  it('rejects a wrong schema version', () => {
    const result = loadConfig(`
schema_version: 2
project:
  name: demo-repo
`);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.path === 'schema_version')).toBe(true);
  });

  it('rejects out-of-bounds numbers', () => {
    const config = defaultConfig('demo-repo', 'node-pnpm');
    config.updates.cooldown_days = 500;
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
  });

  it('rejects an empty allowed_authors list', () => {
    const config = defaultConfig('demo-repo', 'node-pnpm');
    config.merge.allowed_authors = [];
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
  });

  it('requires at least one test or smoke command', () => {
    const config = defaultConfig('demo-repo', 'node-pnpm');
    config.validation.test = null;
    config.validation.smoke = null;
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.path === 'validation')).toBe(true);
  });

  it('accepts the default config unchanged', () => {
    const result = validateConfig(defaultConfig('demo-repo', 'node-pnpm'));
    expect(result.ok).toBe(true);
  });

  it('rejects forbidden_paths entries that are not strings', () => {
    const config = defaultConfig('demo-repo', 'node-pnpm');
    (config.repair.forbidden_paths as unknown[]).push(42);
    const result = validateConfig(config);
    expect(result.ok).toBe(false);
  });
});
