// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { laneForRoute, scrollToLane, type Lane } from './laneTarget'
import type { AppRoute } from './routes'

describe('laneForRoute (issue 089 D2 P2 — routes as scroll-to-lane deep-links)', () => {
  // Each retained tier/design route maps to the lane it should scroll into view;
  // everything else (project — which redirects — and the non-workspace routes)
  // has no lane, so scrolling is a no-op.
  const cases: { route: AppRoute; lane: Lane | null; name: string }[] = [
    { name: 'foundation tier → foundation lane', route: { kind: 'tier', projectId: 'p1', tier: 'foundation' }, lane: 'foundation' },
    { name: 'architecture tier → architecture lane', route: { kind: 'tier', projectId: 'p1', tier: 'architecture' }, lane: 'architecture' },
    { name: 'design at depth 0 → design lane', route: { kind: 'design', projectId: 'p1', contextPath: [], view: 'canvas' }, lane: 'design' },
    { name: 'design at depth > 0 → design lane', route: { kind: 'design', projectId: 'p1', contextPath: ['a', 'b'], view: 'coverage' }, lane: 'design' },
    // `project` immediately redirects to a concrete tier/design route (App.tsx
    // lastTierRoute), which then drives the scroll — no lane of its own.
    { name: 'project → null (redirect drives the scroll)', route: { kind: 'project', projectId: 'p1' }, lane: null },
    { name: 'projects list → null', route: { kind: 'projects' }, lane: null },
    { name: 'login → null', route: { kind: 'login' }, lane: null },
    { name: 'not-found → null', route: { kind: 'not-found', path: '/x' }, lane: null },
  ]

  for (const { name, route, lane } of cases) {
    it(name, () => {
      expect(laneForRoute(route)).toBe(lane)
    })
  }
})

describe('scrollToLane', () => {
  // jsdom implements no matchMedia, so scrollToLane's `window.matchMedia?.(…)`
  // optional-chains to undefined (→ smooth) unless a test installs one.
  const originalMatchMedia = window.matchMedia

  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
    window.matchMedia = originalMatchMedia
  })

  function mountLane(lane: Lane): HTMLElement {
    const el = document.createElement('section')
    el.className = `workspace__lane workspace__lane--${lane}`
    document.body.appendChild(el)
    return el
  }

  it('scrolls the matching lane into view at its top', () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    const lane = mountLane('design')
    scrollToLane('design')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.instances[0]).toBe(lane)
    expect(spy).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' })
  })

  it('is a no-op for a null lane', () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    scrollToLane(null)
    expect(spy).not.toHaveBeenCalled()
  })

  it('guards when the lane is not yet mounted (no throw, no call)', () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    expect(() => scrollToLane('foundation')).not.toThrow()
    expect(spy).not.toHaveBeenCalled()
  })

  it('respects prefers-reduced-motion by snapping (behavior: auto)', () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia
    mountLane('architecture')
    scrollToLane('architecture')
    expect(spy).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' })
  })
})
