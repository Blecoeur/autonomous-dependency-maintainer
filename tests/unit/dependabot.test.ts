import { describe, expect, it } from 'vitest';
import { parseDependabotTitle } from '../../src/policy/dependabot.js';

describe('parseDependabotTitle', () => {
  it('parses a standard bump title', () => {
    expect(parseDependabotTitle('Bump express from 4.18.2 to 4.19.0 in /packages/server')).toEqual([
      { name: 'express', fromVersion: '4.18.2', toVersion: '4.19.0', updateType: 'minor' },
    ]);
  });

  it('parses a chore-prefixed title', () => {
    expect(parseDependabotTitle('chore(deps): bump zod from 3.22.0 to 3.23.0')).toEqual([
      { name: 'zod', fromVersion: '3.22.0', toVersion: '3.23.0', updateType: 'minor' },
    ]);
  });

  it('classifies major moves', () => {
    expect(parseDependabotTitle('Bump eslint from 8.57.0 to 9.0.0')[0]?.updateType).toBe('major');
  });

  it('returns an empty array for grouped titles without version pairs', () => {
    expect(parseDependabotTitle('Bump the npm_and_yarn group with 2 updates')).toEqual([]);
  });

  it('returns an empty array when versions do not parse', () => {
    expect(parseDependabotTitle('Bump express from 4.18 to 4.19')).toEqual([]);
  });

  it('returns an empty array for non-dependabot titles', () => {
    expect(parseDependabotTitle('Fix login flow regression')).toEqual([]);
  });
});
