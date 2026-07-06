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
// jsdom disables Web Storage on its default opaque origin, so `localStorage` is
// undefined under vitest's jsdom env. The app uses it (backup-note memory,
// last-tier recall); an in-memory shim gives components a working store in
// tests without depending on a configured jsdom URL.
if (typeof window !== 'undefined' && !('localStorage' in window && window.localStorage)) {
  class MemoryStorage {
    private store = new Map<string, string>()
    get length() {
      return this.store.size
    }
    clear() {
      this.store.clear()
    }
    getItem(key: string) {
      return this.store.has(key) ? (this.store.get(key) as string) : null
    }
    setItem(key: string, value: string) {
      this.store.set(key, value)
    }
    removeItem(key: string) {
      this.store.delete(key)
    }
    key(index: number) {
      return [...this.store.keys()][index] ?? null
    }
  }
  Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), configurable: true })
}
