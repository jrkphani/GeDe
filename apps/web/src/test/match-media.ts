/**
 * `window.matchMedia` for jsdom. `installMatchMedia(matches)` answers every
 * query the same way; pass a function to decide per query, e.g.
 * `installMatchMedia((q) => q.includes('767'))` to simulate a phone.
 */
export function installMatchMedia(matches: boolean | ((query: string) => boolean)): void {
  const decide = typeof matches === 'function' ? matches : () => matches;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: decide(query),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}
