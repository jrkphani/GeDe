/**
 * `window.matchMedia` for jsdom. `installMatchMedia(matches)` answers every
 * query the same way; pass a function to decide per query, e.g.
 * `installMatchMedia(phoneMedia)` to simulate a phone, or
 * `installMatchMedia((q) => q.includes('767.98'))` for a narrow fine-pointer
 * window (a desktop at 200 % zoom, which is not a phone — ADR-039).
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

/** A phone: every `max-width` query up to 1023.98 px matches, and the pointer is coarse. */
export function phoneMedia(query: string): boolean {
  return (
    query.includes('767.98') ||
    query.includes('899.98') ||
    query.includes('1023.98') ||
    query === '(pointer: coarse)' ||
    query === '(hover: none)'
  );
}
