export { theme, type Theme } from './theme.js';
import { theme } from './theme.js';

/** Breakpoint minimums in CSS pixels, mirrored from `--bp-*` in tokens.css. */
export const bp = theme.breakpoint;
export type Breakpoint = keyof typeof bp;

/** Media query string for "at least this breakpoint" (`min-width`). */
export function atLeast(name: Exclude<Breakpoint, 'xs'>): string {
  return `(min-width: ${bp[name]}px)`;
}

/** Media query string for "narrower than this breakpoint" (`max-width`). */
export function below(name: Exclude<Breakpoint, 'xs'>): string {
  return `(max-width: ${bp[name] - 0.02}px)`;
}

/** Canvas lattice geometry in CSS pixels — absolute, never on the space scale. */
export const lattice = theme.lattice;
export type Lattice = typeof lattice;

/** Loading tiers in milliseconds (LOAD-01, LOAD-02). */
export const loading = theme.loading;

/** Motion durations (ms) and easings. */
export const motion = theme.motion;
