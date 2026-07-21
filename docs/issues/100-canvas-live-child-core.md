# 100: Canvas — promote the recursion satellite STUB to a live child {register + ring} core

- **Status**: OPEN — **Phase A SHIPPED (2026-07-21)**; Phases B–E remain. The tracked 089-P3 follow-up; non-blocking (089 graduated with satellites as read-only summary stubs).
  - **Phase A DONE (`canvasStores.ts` factory + registry + default-instance shim).** New `src/store/canvasStores.ts` composition root: `createCanvasStores(canvasId)` builds the 3 factory instances wired to each other via a lazy `() => stores` sibling accessor; `Map` registry with `getCanvasStores`/`releaseCanvasStores` (never releases default); default-instance shims `useContextsStore`/`useDimensionsStore`/`useCanvasComposeStore` + `resetContextsStore`/`resetDimensionsStore`/`resetCanvasCompose` re-exported from the 3 store modules so every existing import path is unchanged. `contexts.ts`/`dimensions.ts`/`canvasCompose.ts` bodies moved into hoisted `createXStore()` factories; module `let syncUnsubscribe` → per-instance closure var (risk 1 resolved); all sibling `getState()` reads redirected to `getStores().use*` (dimensions→contexts ×3; compose→contexts ×9, →dimensions ×4; risk 2 resolved); `parameters` untouched (global). **Only the default instance is instantiated in Phase A → byte-identical runtime behavior.** Verified: tsc + eslint clean, prod build clean (no circular-dep warnings), `verify:fast` 1665, full e2e 96/96. **Adversarially reviewed (`code-reviewer`) — CLEAN**: all 6 probes (circular-init across all entry orders, sibling-wire completeness, per-instance unsubscribe, reset semantics, seed/lazy-accessor, undo closure binding) confirmed safe.
  - **Phase-B-latent risks flagged by the Phase A review (NOT blockers; address in Phase B):** (1) the circular-init safety is an *implicit* invariant (factories must stay hoisted `function` decls; `CanvasStores` must stay a type-only import) — now documented in a ⚠️ comment atop `canvasStores.ts`; no `import/no-cycle` lint enforces it. (2) `getCanvasStores(non-null)`/`releaseCanvasStores` are dead code until Phase B — zero existing coverage of the registry `Map`/teardown/multi-instance resolution. (3) `stores.teardown` hand-wires contexts+dimensions only (compose has no sub today) — not structurally guaranteed. (4) shared global `commandLog`/`status`/`sync`/`parameters` across future per-canvas instances → Phase B must plan cross-canvas undo interleaving (one global LIFO — matches the owner's ONE-GLOBAL-HISTORY decision).
- **Milestone**: M7 (089 canvas). **Depends on**: 089-P3 (satellites, SHIPPED), 090 (multi-canvas backend, SHIPPED).

## Context

089-P3 shipped recursion (011) as edge-connected child-canvas **satellites**: drilling "Open ▸" spawns a summary-STUB node (symbol + child count) with a parent→child edge; authoring the child still requires "Enter ▸" (which navigates and re-scopes the single core). The spec's north-star "cluster" is an open child **fully editable IN PLACE beside its parent** — a live {register + ring} core, not a stub.

## The reframe (from the 2026-07-21 scoping investigation)

**This is a CLIENT-SIDE store-lifetime refactor, not a data-model one.** 090 already made the entire backend canvas-parametric — every read/write/sync/RLS/envelope path takes an explicit `canvasId` (`contexts.ts:29-36`, `dimensions.ts:27-33`, done/090). The **only** remaining singleton is the client Zustand store *instance*: `contexts` / `dimensions` / `canvasCompose` (and nominally `parameters`) are module-level singletons whose `load(projectId, canvasId)` **swaps the whole store to one active canvas** (`contexts.ts:247-263`). A second live core calls `load()` on the same singleton and clobbers the first. Making children live = making those instances **per-canvas**.

### Blast radius (measured)
- **~13 non-test source files + ~16 test files.** Concentrated: the 4 stores + the live-core surfaces (`DesignCoreAdapter`, `ContextRegister`, `DimensionManager`, `ParameterList`, `WorkspaceCanvas`). Incidental reads: `presence.ts`, `tier2.ts`, `coreCommands.ts`, `DesignSurface.tsx` (fallback).
- Hook consumers: `useContextsStore` 22 files / `useDimensionsStore` 18 / `useParametersStore` 15 / `useCanvasComposeStore` 2. **210** `useContextsStore.getState()` static calls — the number that dictates the seam (below).

### Two findings that shrink scope
- **`parameters` is keyed by `dimensionId`, NOT canvasId** (`parameters.ts:47-51`, `byDimension`). Dimension ids are globally unique and belong to exactly one canvas (090 FK), so two live cores' parameters **already coexist** in the single map. **Recommendation: leave `parameters` a shared/global store** — do not split it (revisit only if a real collision surfaces).
- **`canvasCompose` holds one field** (`composeContextId`) and has **2 consumers**; it reads the other three via `getState()`, so under the factory it just needs its `getState()` reads pointed at *its own core's* sibling instances.

## The seam (decided)

A **keyed registry factory**, NOT a React-Context provider: 210 `getState()` calls happen OUTSIDE React (undo closures in `contexts.ts`/`dimensions.ts`, the whole `canvasCompose` machine, `coreCommands.ts`) and cannot read context.

- New `src/store/canvasStores.ts`: `createCanvasStores(canvasId)` builds the per-canvas instances **wired to each other** (compose/dimensions cross-reads capture sibling refs, not module singletons), memoized per `canvasId`, with `getCanvasStores(canvasId)` + `releaseCanvasStores(canvasId)`.
- The exported `useContextsStore` etc. become a **default-instance shim** (`getCanvasStores(activeCanvasId)`) so every not-yet-migrated consumer (fallback surface, tier2, presence, palette) keeps working unchanged during migration — the whole refactor stays phaseable with **zero behavior change** until a surface opts into its own instance.
- The core bodies already carry the canvas identity as data (`DesignBodyProps.canvasId`, `WorkspaceCanvas` passes it in RF node `data`; `useDesignCanvasContext` resolves it) — today it feeds `load()`; after 100 it selects an instance.

## Owner decisions (2026-07-21)

- **Active core = FOCUS-FOLLOWS.** When two cores are live, the core containing the focused element is active; the global keyboard verbs (`c`/`v`/`d`/Tab-bridge in `DesignRegisterBody`, currently `window` capture-phase gated only on `activeLane==='design'`) target *that* core. No explicit "select a core" UI. Mirrors the existing `activeLane` focus-based pattern. **Implication:** introduce an "active canvas" notion (a slice mirroring `activeLane`, or derive from focus) so the duplicated global handlers don't both fire.
- **Undo = ONE GLOBAL HISTORY.** ⌘Z undoes the last edit on *either* core in one shared timeline (matches today's global `commandLog` + the ⌘Z convention). Works automatically via the factory's captured closures — each undo entry's closure binds to the instance that created it. **Confirm** each entry targets the right instance; no per-core history.

## Phased build plan (≤5 files/phase; [M]echanical / [D]esign)

- **Phase A [M, large] — factory + registry, default instance only. ✅ SHIPPED 2026-07-21.** New `canvasStores.ts`; refactored `contexts.ts`/`dimensions.ts`/`canvasCompose.ts` to be *produced by* `createCanvasStores`, with **per-instance** sync subscriptions + `resetXStore`→registry teardown; `useContextsStore` etc. kept as a default-instance shim. **Green with zero behavior change** (default instance only). *4 files (1 new).* Self-contained heavyweight — done, adversarially reviewed clean. **Stop point honored:** Phase B (thread `canvasId` into surfaces) is the next increment.
- **Phase B [D+M] — thread `canvasId` into the live-core surfaces.** `DesignCoreAdapter`, `ContextRegister`, `DimensionManager`, `ParameterList`, `WorkspaceCanvas` resolve their instance from the node's `canvasId` (a small `useCanvasStores(canvasId)` render hook) instead of the module singleton. *~5 files.* The Rule-12 breadth.
- **Phase C [D] — active-canvas (focus-follows) + focus-pan.** New active-canvas slice (mirror `activeLane`, focus-derived); gate the `c`/`v`/`d`/Tab handlers on it; extend `workspaceFocusPan` for two cores' geometry. *~3-4 files.* The main design work — now de-risked by the focus-follows decision above.
- **Phase D [M+D] — satellite goes LIVE.** `SatelliteNode`/`WorkspaceCanvas` render a live child core (register+ring) bound to the child `canvasId` (resolvable via `resolveReadCanvasId(db, projectId, parentContextId)`), lazily `getCanvasStores`/`release` on open/collapse, LOD-gated (only on-path/near-viewport clusters live; collapsed/deep stay P3 stubs). **Edit-aware mount/unmount** (never unmount a core mid-edit — the 089-P5 lesson). e2e `@dev-flag`: Open ▸ a child → edit its register in place (no navigate) → parent core stays live + independent. *~3-4 files.*
- **Phase E [D] — incidental consumers + fallback.** Resolve `tier2` (which canvas's dimensions Architecture links against when two are live — **open decision**), `presence`, `coreCommands` (palette verbs → active/default instance), and confirm `DesignSurface.tsx` fallback stays on the default instance. *~4 files.*
- Tests interleaved per phase (~16 files: the `resetXStore` singleton-reset sites become registry teardown).

## Risks (mandatory adversarial review on Phase A + any store/write-path touch)

1. **Per-instance `syncUnsubscribe`** — the module-level single unsubscribe (`contexts.ts:82`, `dimensions.ts:65`, `parameters.ts:19`) MUST move inside the factory per instance, or a second core's `load()` overwrites the first's unsubscribe → leaked/killed listeners. The one concrete sync hazard; mechanical.
2. **Cross-store `getState()` wiring** — `canvasCompose` + `dimensions.syncBindingsForContexts→contexts` must reach the *same core's* siblings. Crux of the factory design.
3. **Duplicated global keyboard handlers** — two live cores both mount the `window` capture-phase `c`/`v`/`d`/Tab listeners; the active-canvas gate (Phase C) must arbitrate.
4. **Undo closure binding** — confirm one global history's entries target the right instance.
5. **Focus-pan across two cores**; **tier2 cross-lane linkage** (Phase E decision); **test churn** (~16 files).

## Non-goals

Changing the `?d3rf`/capability gate or the route grammar (090 owns multi-canvas identity). Splitting the `parameters` store (dimension-keyed, already collision-free). This is purely the store-lifetime refactor that unlocks live child cores.

## Definition of done

Open ▸ a child satellite mounts a live {register+ring} core editable in place; the parent core stays live + independent; focus-follows drives the keyboard verbs; ⌘Z spans both in one history; collapsed/deep children stay stubs (LOD); `npm run verify` + full e2e green; adversarially reviewed.
