import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => {
  cleanup();
});

// jsdom gaps that Radix primitives touch. Each is a no-op that mirrors the
// "no pointer capture, no layout" reality of jsdom.
type PointerGaps = Partial<
  Pick<
    Element,
    'hasPointerCapture' | 'setPointerCapture' | 'releasePointerCapture' | 'scrollIntoView'
  >
>;
const proto: PointerGaps = window.Element.prototype;
proto.hasPointerCapture ??= () => false;
proto.setPointerCapture ??= () => undefined;
proto.releasePointerCapture ??= () => undefined;
proto.scrollIntoView ??= () => undefined;

// floating-ui probes the top layer (`:popover-open`, `:modal`) on every
// ancestor; nwsapi answers those selectors in seconds, not microseconds.
// jsdom has no top layer, so the answer is always "no".
const TOP_LAYER = new Set([':popover-open', ':modal']);
// eslint-disable-next-line @typescript-eslint/unbound-method -- rebound with .call below
const nativeMatches = window.Element.prototype.matches;
window.Element.prototype.matches = function matches(this: Element, selector: string): boolean {
  if (TOP_LAYER.has(selector)) return false;
  return nativeMatches.call(this, selector);
};

if (typeof window.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {
      /* no layout in jsdom */
    }
    unobserve(): void {
      /* no layout in jsdom */
    }
    disconnect(): void {
      /* no layout in jsdom */
    }
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
}
