# 106: Canvas live-child-core — refinements (follow-ups from 100)

- **Status**: OPEN — non-blocking follow-ups banked when **`100` (live child-canvas core) shipped + was archived (2026-07-22)**. The core DoD is met (drilling mounts a live, independent, editable child core; CI-green + deployed); these are polish/robustness items, none crash or corrupt data.
- **Milestone**: M7 (canvas). **Follows**: 100 (`done/100-canvas-live-child-core.md`).

## Items

1. **Zoom-LOD auto-culling of off-screen / deep child cores → stubs.** The 100 DoD's LOD clause ("collapsed/deep children stay P3 stubs") was DEFERRED. Today every opened child core stays fully live until its collapse `×` — so drilling many children mounts many live `{register+ring}` cores (each with its own store instance + sync sub). Add a zoom/near-viewport LOD gate that demotes off-path / deep / zoomed-out child cores back to summary stubs. **Hazard (089-P5 lesson):** never unmount a core mid-edit — gate the demotion on a focus-within ref (mirror `useLaneLod`'s ref pattern, `WorkspaceCanvas.tsx`), and release its stores (`releaseCanvasStores`) only when it truly demounts.

2. **Nested drill (grandchild) mispositioning.** Drilling INSIDE a live child core lands the grandchild in the same top-level `useCanvasSatellitesStore.open[]`, so `WorkspaceCanvas` renders it as if it were a direct child of the PRIMARY: its parent→child edge sources `LANE_NODE_ID.design` (the primary register, not the child's) and its `computeSatelliteLayout` position isn't nested-aware. **Its store instance IS correctly independent + keyed** (no crash / corruption) — this is purely cosmetic edge/position. Fix: make the satellite state + cluster layout depth/parent-aware so a grandchild edges + positions off its real parent core.

3. **Presence doesn't reach a child-core selection.** `presence.ts:109` subscribes the DEFAULT contexts instance, so a context selected INSIDE a live child core (a non-default instance) never publishes a presence highlight (stale cue; no crash). If presence-in-child-cores is wanted, subscribe per-live-instance (or thread the active instance's selection into presence).

4. **Command palette "go to context" is root-only.** `coreCommands.ts:80` lists + selects on the DEFAULT (root) contexts instance and navigates to `contextPath: []`. Correct-by-default for a global affordance, but it can't reach a child core's contexts. If desired, extend the palette to enumerate live child cores' contexts.

## Notes
`storeCanvasId` ≠ `canvasId` and the primary core MUST resolve the DEFAULT instance — see the 100 store-architecture patterns in `HANDOFF.md`. The `createCanvasStores` circular-init invariant (hoisted `function` factories + type-only `CanvasStores` import) is unlinted — do not break it.

## Definition of done
LOD-gated child cores (deep/off-path demote to stubs, edit-aware); nested drill edges+positions off the real parent; (optional) presence + palette reach live child cores. `npm run verify` + full e2e green; adversarially review any store/render-path touch.
