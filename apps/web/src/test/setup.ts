import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { setConfigForTests } from '../config.js';
import { installMatchMedia } from './match-media.js';
import { installRequestSignalBridge, installWebStorage } from './storage.js';

installWebStorage();
installRequestSignalBridge();

afterEach(() => {
  cleanup();
  setConfigForTests(null);
  localStorage.clear();
  sessionStorage.clear();
});

installMatchMedia(false);

// jsdom gaps that Radix primitives touch (see packages/ui/src/test/setup.ts).
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
