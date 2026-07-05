import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(() => {
  cleanup()
})

// DB/domain tests run in the plain 'node' environment (no DOM globals) —
// only polyfill when jsdom is actually the active environment.
if (typeof Element !== 'undefined') {
  // jsdom implements neither API; Radix's Popover/Popper primitives call
  // both on pointer interaction, so triggers silently fail to open under
  // jsdom without these no-op polyfills (issue 004, EditableGrid combobox).
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {}
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {}
  }
  // cmdk calls this in a layout effect on mount/selection change; jsdom has
  // no implementation at all, and the resulting throw silently aborts
  // whatever commit was in flight (a Popover open looks like it never
  // happened).
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {}
  }
}
if (typeof window !== 'undefined' && !window.ResizeObserver) {
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
