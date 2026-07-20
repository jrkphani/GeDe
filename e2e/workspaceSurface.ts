import type { Page } from '@playwright/test'

// 089-P7 (the canvas default-flip) — e2e test seam.
//
// At P7 the React Flow WorkspaceCanvas became the DEFAULT surface for the
// project/tier/design routes on capable (≥ 1024px, non-data-saver) clients,
// with the D2 stacked-lane `WorkspaceSurface` retained as the < 1024px /
// reduced-data FALLBACK (App.tsx reads `canvasMode.canvasEnabled`, seeded once
// at boot from `canvasCapable()` — see src/store/canvasMode.ts).
//
// The specs in this directory that are NOT tagged `@dev-flag` were authored
// against the WorkspaceSurface DOM and interaction models: the register/rail in
// one native scroll region, the `New context` button, `.editing-zone` stacking
// geometry, the `.t2-table` stacked Architecture panels with in-grid `Reorder`
// drag handles, container-width label tiers, breadcrumb recursion, `<main>` for
// axe, and forward cross-table keyboard threading. Those surfaces still SHIP —
// they are exactly what a narrow / data-saver client renders — so exercising
// them is honest fallback-path coverage, NOT a weakened test. The CANVAS
// equivalents (register-in-node grammar, `c`-key compose, the coverage twin,
// recursion satellites, per-table/per-prop decomposed nodes + node-handle drag,
// LOD summaries, cross-node Tab) have their own dedicated suite in
// `d3-canvas.spec.ts` (21 `@dev-flag` specs that gate the deploy).
//
// `canvasCapable()` returns `false` when `matchMedia('(prefers-reduced-data:
// reduce)')` reports `matches: true`. That media query is used NOWHERE else in
// the app (verified: only src/store/canvasMode.ts reads it), so intercepting it
// here forces the WorkspaceSurface fallback at ANY viewport width — leaving the
// width-crossing specs (which resize themselves to assert responsive layout /
// label tiers) free to keep their exact intended widths. The interceptor
// delegates every other query to the real `matchMedia`, so `prefers-reduced-
// motion`, `color-scheme`, `min-width` etc. behave normally. It is a pure
// TEST seam: no app source is changed, and `canvasMode` seeds from it at boot
// because `addInitScript` runs before any page script.
export async function forceWorkspaceSurface(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const REDUCED_DATA = '(prefers-reduced-data: reduce)'
    const original = window.matchMedia.bind(window)
    const noop = (): void => undefined
    window.matchMedia = (query: string): MediaQueryList => {
      if (query === REDUCED_DATA) {
        // A minimal, spec-shaped MediaQueryList that always matches, so
        // canvasCapable() reads the client as a data-saver → canvas OFF.
        return {
          matches: true,
          media: query,
          onchange: null,
          addEventListener: noop,
          removeEventListener: noop,
          addListener: noop,
          removeListener: noop,
          dispatchEvent: () => false,
        }
      }
      return original(query)
    }
  })
}
