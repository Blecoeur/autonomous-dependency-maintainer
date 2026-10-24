import { describe, expect, it } from 'vitest';
import { guardManifests } from '../../src/policy/manifests.js';

const PKG = (scripts: Record<string, string>, deps: Record<string, string> = {}) =>
  JSON.stringify({ name: 'x', scripts, dependencies: deps });

describe('guardManifests', () => {
  it('passes when only dependencies change', () => {
    const result = guardManifests([
      {
        path: 'package.json',
        before: PKG({ test: 'vitest run', build: 'tsc' }, { express: '^4.18.2' }),
        after: PKG({ test: 'vitest run', build: 'tsc' }, { express: '^4.19.0' }),
      },
    ]);
    expect(result.changedProtectedKeys).toEqual([]);
    expect(result.addedOrRemoved).toEqual([]);
  });

  it('detects removal of the test script', () => {
    const result = guardManifests([
      {
        path: 'package.json',
        before: PKG({ test: 'vitest run', build: 'tsc' }),
        after: PKG({ build: 'tsc' }),
      },
    ]);
    expect(result.changedProtectedKeys).toEqual(['package.json#scripts']);
  });

  it('detects weakening the test script to a no-op', () => {
    const result = guardManifests([
      {
        path: 'packages/ui/package.json',
        before: PKG({ test: 'vitest run' }),
        after: PKG({ test: 'echo ok' }),
      },
    ]);
    expect(result.changedProtectedKeys).toEqual(['packages/ui/package.json#scripts']);
  });

  it('reports added or removed manifests', () => {
    const result = guardManifests([
      { path: 'packages/new/package.json', before: null, after: PKG({}) },
    ]);
    expect(result.addedOrRemoved).toEqual(['packages/new/package.json']);
  });

  it('treats unparseable snapshots as protected changes', () => {
    const result = guardManifests([
      { path: 'package.json', before: 'not json', after: PKG({}) },
    ]);
    expect(result.addedOrRemoved).toEqual(['package.json']);
  });

  it('ignores key order differences in nested script objects', () => {
    const result = guardManifests([
      {
        path: 'package.json',
        before: PKG({ a: 'x', b: 'y' }),
        after: PKG({ b: 'y', a: 'x' }),
      },
    ]);
    expect(result.changedProtectedKeys).toEqual([]);
  });
});
