// Issue 089 D2 P2 — the three tier routes are RETAINED (they still parse/
// serialize and drive `tab--active`); D2 re-casts them as scroll-to-lane
// deep-links into the single unified `WorkspaceSurface` page. This module is
// the seam between "which route is active" and "which of the three
// `.workspace__lane--*` sections to bring into view".

import type { AppRoute } from './routes'

export type Lane = 'foundation' | 'architecture' | 'design'

// PURE, no side effects — the whole point is a testable route→lane table.
// `tier` routes carry the lane in `route.tier` (a subset of Lane); a `design`
// route of any depth targets the Design lane. Everything else has no lane:
// `project` immediately redirects to a concrete tier/design route (App.tsx
// `lastTierRoute`), which then drives the scroll, and the non-workspace routes
// (projects / welcome / login / auth-callback / not-found) mount no lanes.
export function laneForRoute(route: AppRoute): Lane | null {
  switch (route.kind) {
    case 'tier':
      return route.tier
    case 'design':
      return 'design'
    default:
      return null
  }
}

// Imperative DOM companion to laneForRoute — kept in the same module so the
// route→lane→scroll path lives in one place (App.tsx's route effect and
// AppShell's ⌘1/2/3 handler both call it). Guards the not-yet-mounted case
// (status !== 'ready', or a `project` route mid-redirect before WorkspaceSurface
// paints its lanes): a missing lane element is a silent no-op. Mirrors
// ArchitectureSurface's quick-jump `scrollIntoView({ block: 'start' })`, and
// snaps (behavior: 'auto') under prefers-reduced-motion (STYLE_GUIDE §8).
export function scrollToLane(lane: Lane | null): void {
  if (!lane) return
  const el = document.querySelector(`.workspace__lane--${lane}`)
  if (!el) return
  // `matchMedia` is guaranteed by the DOM lib types but absent under jsdom
  // (unit tests) — read it through Partial<Window> so the presence check is a
  // real runtime guard, not a type-"unnecessary" one.
  const matchMedia = (window as Partial<Window>).matchMedia
  const reduce = matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
}
