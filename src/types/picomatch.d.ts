/**
 * Minimal ambient declaration for picomatch, covering only the API surface
 * used by this framework (`isMatch`). picomatch's runtime types are not part
 * of its published package in all versions; keeping the declaration local
 * documents exactly what we depend on.
 */
declare module 'picomatch' {
  export interface PicomatchOptions {
    /** Match dotfiles and paths containing dot-directories like `.github`. */
    dot?: boolean;
  }
  export function isMatch(str: string, pattern: string, options?: PicomatchOptions): boolean;

  const picomatch: {
    isMatch: typeof isMatch;
  };
  export default picomatch;
}
