import { isVersion, updateType } from './semver.js';
import type { DependencyUpdate } from './pr.js';

const TITLE_RE = /bump\s+(\S+)\s+from\s+(\S+)\s+to\s+(\S+)/i;

/**
 * Parses a Dependabot PR title such as
 * `Bump express from 4.18.2 to 4.19.0 in /packages/server`.
 * Returns the single dependency movement when the title matches, or an empty
 * array for grouped updates whose titles carry no version pairs — the caller
 * then treats the update type as unverified.
 */
export function parseDependabotTitle(title: string): DependencyUpdate[] {
  const match = TITLE_RE.exec(title.trim());
  if (!match) {
    return [];
  }
  const name = match[1];
  const fromVersion = match[2];
  const toVersion = match[3];
  if (!name || !fromVersion || !toVersion) {
    return [];
  }
  const type = updateType(fromVersion, toVersion);
  if (!type || !isVersion(fromVersion) || !isVersion(toVersion)) {
    return [];
  }
  return [{ name, fromVersion, toVersion, updateType: type }];
}
