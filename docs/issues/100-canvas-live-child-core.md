# 100: Canvas — promote the recursion satellite STUB to a live child {register + ring} core

- **Status**: OPEN — the tracked 089-P3 follow-up, deferred past graduation as its own phase (owner may sequence anytime). Non-blocking: 089 graduated (P7 SHIPPED) with satellites as read-only summary stubs.
- **Milestone**: M7 (089 canvas). **Depends on**: 089-P3 (satellites, SHIPPED), 090 (multiple canvases — related store shape).

## Context

089-P3 shipped recursion (011) as edge-connected child-canvas **satellites**: drilling "Open ▸" spawns a summary-STUB node (symbol + child count) with a parent→child edge; authoring the child still requires Enter ▸ (which navigates and re-scopes the single core). The spec's north-star "cluster" is an open child that is **fully editable IN PLACE beside its parent** — a live {register + ring} core, not a stub.

## The blocker (why it's its own phase)

A live child core needs TWO live cores mounted at once (parent + child), but the `contexts` store (and `dimensions` / `parameters` / `canvasCompose`) is a **singleton** keyed to the single active canvas. Making children live requires those stores to become **per-canvas instances** — a store factory keyed by `canvasId` — instead of singletons. That is a central refactor touching every store consumer (a Rule-12 sweep across the app), so it gets its own budget + mandatory adversarial review.

It composes with P5's lazy-mount/LOD: only on-path clusters mount live; deep collapsed children stay stubs.

## Sketch (to be planned properly before building)

- A `createCanvasStores(canvasId)` factory (or a keyed registry) replacing the singleton `contexts`/`dimensions`/`parameters`/`canvasCompose` slices; a provider/selector seam so each RF core node reads its own instance.
- Rule-12 sweep of every consumer of those stores (grep `useContextsStore` / `useDimensionsStore` / `useParametersStore` / `canvasCompose`).
- LOD/lazy-mount: live cores only for the on-path (expanded, near-viewport) cluster; collapsed/deep children stay P3 stubs.
- e2e (`@dev-flag`): open a child satellite → edit its register in place (no navigate) → parent core stays live + independent.

## Non-goals

Changing the `?d3rf`/capability gate or the route grammar (090 owns multi-canvas identity). This is purely the store-lifetime refactor that unlocks live child cores.
