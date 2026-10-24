import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  isVersion,
  nextSourceAwareVersion,
  parseVersion,
  updateType,
} from '../../src/policy/semver.js';

describe('parseVersion', () => {
  it('parses plain versions', () => {
    expect(parseVersion('2.8.1')).toEqual({ major: 2, minor: 8, patch: 1, prerelease: [] });
  });

  it('parses prerelease and build metadata', () => {
    const parsed = parseVersion('1.2.3-beta.1+build.5');
    expect(parsed).not.toBeNull();
    expect(parsed?.prerelease).toEqual(['beta', '1']);
  });

  it('rejects ranges and loose specifiers', () => {
    expect(parseVersion('^1.2.3')).toBeNull();
    expect(parseVersion('~2.0')).toBeNull();
    expect(parseVersion('latest')).toBeNull();
    expect(parseVersion('1.2')).toBeNull();
  });
});

describe('isVersion', () => {
  it('accepts only concrete versions', () => {
    expect(isVersion('3.0.0')).toBe(true);
    expect(isVersion('3.0')).toBe(false);
    expect(isVersion('*')).toBe(false);
  });
});

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions(parseVersion('2.10.0')!, parseVersion('2.9.0')!)).toBe(1);
  });

  it('treats a release as higher than its prereleases', () => {
    expect(compareVersions(parseVersion('1.0.0-rc.1')!, parseVersion('1.0.0')!)).toBe(-1);
  });

  it('orders prereleases per semver precedence', () => {
    expect(compareVersions(parseVersion('1.0.0-alpha')!, parseVersion('1.0.0-beta')!)).toBe(-1);
    expect(compareVersions(parseVersion('1.0.0-alpha.2')!, parseVersion('1.0.0-alpha.10')!)).toBe(-1);
  });
});

describe('updateType', () => {
  it('classifies patch, minor and major moves', () => {
    expect(updateType('2.8.1', '2.8.2')).toBe('patch');
    expect(updateType('2.8.2', '2.9.0')).toBe('minor');
    expect(updateType('2.9.0', '3.0.0')).toBe('major');
  });

  it('returns null for unparsable input', () => {
    expect(updateType('2.9.0', 'latest')).toBeNull();
  });
});

describe('nextSourceAwareVersion', () => {
  it('bumps PATCH for dependency-only releases', () => {
    expect(nextSourceAwareVersion('3.2.4', false)).toBe('3.2.5');
  });

  it('bumps MINOR and resets PATCH when an AI-assisted fix is included', () => {
    expect(nextSourceAwareVersion('3.2.5', true)).toBe('3.3.0');
  });

  it('never touches the major digit', () => {
    expect(nextSourceAwareVersion('3.9.9', true)).toBe('3.10.0');
    expect(nextSourceAwareVersion('3.9.9', false)).toBe('3.9.10');
  });

  it('returns null for unparsable current versions', () => {
    expect(nextSourceAwareVersion('v3', false)).toBeNull();
  });
});
