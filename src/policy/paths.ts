import picomatch from 'picomatch';

/**
 * Glob matching over file paths, used for protected-path and allowed-path
 * policies. Patterns follow picomatch semantics with `dot: true` so that
 * entries like `.github/**` behave as expected.
 */
export function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => picomatch.isMatch(path, pattern, { dot: true }));
}

export function matchedPatterns(path: string, patterns: string[]): string[] {
  return patterns.filter((pattern) => picomatch.isMatch(path, pattern, { dot: true }));
}
