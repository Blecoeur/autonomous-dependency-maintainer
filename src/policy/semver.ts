export type UpdateType = 'major' | 'minor' | 'patch';

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const VERSION_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Parses strict `MAJOR.MINOR.PATCH[-prerelease]` versions. Ranges and loose
 * specifiers are intentionally out of scope: this is only used to compare two
 * concrete versions reported for an update.
 */
export function parseVersion(input: string): ParsedVersion | null {
  const match = VERSION_RE.exec(input.trim());
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

export function isVersion(input: string): boolean {
  return parseVersion(input) !== null;
}

function comparePrerelease(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1; // fewer segments = higher precedence
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x) ? Number(x) : null;
    const yn = /^\d+$/.test(y) ? Number(y) : null;
    if (xn !== null && yn !== null) {
      return xn < yn ? -1 : 1;
    }
    if (xn !== null) return -1;
    if (yn !== null) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Classifies the semantic distance between two concrete versions.
 * Returns null when either version cannot be parsed.
 */
export function updateType(from: string, to: string): UpdateType | null {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) {
    return null;
  }
  if (b.major !== a.major) return 'major';
  if (b.minor !== a.minor) return 'minor';
  return 'patch';
}

/**
 * Computes the next version for the demonstrator's "source-aware" convention:
 * PATCH bumps when a release contains only dependency updates, MINOR when at
 * least one AI-assisted application fix is included, MAJOR never moves.
 */
export function nextSourceAwareVersion(
  current: string,
  includesAiAssisted: boolean,
): string | null {
  const parsed = parseVersion(current);
  if (!parsed) {
    return null;
  }
  if (includesAiAssisted) {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}
