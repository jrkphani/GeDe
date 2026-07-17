# 092: undo/redo of cross-tier ops doesn't refresh the co-mounted sibling lane (089-D2 follow-up)

- **Status**: OPEN — known follow-up left by 089-D2. Low severity (undo-across-lanes is an uncommon path). Not started.
- **Milestone**: 089-D2 polish.
- **Related**: **089-D2** (the lane page — this is a residual of its cross-lane refresh fix), **006** (command-log undo/redo), **075B** (the `*AppliedAt` refresh subscriptions this reuses).

## Background
089-D2 co-mounts Foundation/Architecture/Design as three lanes on one page. Because the Design lane no longer *remounts* on a route swap, a cross-tier write in the Architecture lane (promote / rename-propagate / resolve) must reactively refresh the already-mounted Design lane. D2 Phase 3b fixed this for the **forward** paths via `notifyLocalApply(['dimensions','parameters'])` in `src/store/sync.ts`, wired into `promote` / `renameEntry` / `resolveKeep` / `resolveDeleteParams` in `src/store/tier2.ts` — it bumps the same `dimensionsAppliedAt` / `parametersAppliedAt` signals the 075B subscriptions in `dimensions.ts` / `parameters.ts` already watch.

## The gap
The **undo/redo command-log closures** of those same cross-tier ops were deliberately left untouched (out of the failing test's scope). So undoing/redoing a promote (or a rename-propagation / resolution) while the Design lane is co-mounted writes to the DB but does **not** bump the `*AppliedAt` signals — the Design register stays stale until a reload, the same symptom D2 P3b fixed on the forward path.

## Fix
Wire `useSyncStore.getState().notifyLocalApply([...])` into the **undo and redo** callbacks of every cross-tier mutation in `src/store/tier2.ts` (mirror the forward-path calls), so an undo/redo refreshes the co-mounted sibling lane exactly like the forward op does. Add a store test: undo of a promote refreshes `useDimensionsStore` for the current canvas (no remount). Keep 090 canvas-scoping (re-list the current `canvasId`, not root).

## References
- `src/store/tier2.ts` (`promote` / `renameEntry` / `resolveKeep` / `resolveDeleteParams` + their command-log `push` undo/redo closures), `src/store/sync.ts` (`notifyLocalApply`), `src/store/dimensions.ts` / `src/store/parameters.ts` (075B `*AppliedAt` subscriptions).
- 089-D2 P3b commit `f5033f2` (the forward-path fix this completes).
