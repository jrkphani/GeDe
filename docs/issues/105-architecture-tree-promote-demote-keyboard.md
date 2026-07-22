# 105: Architecture tree — keyboard promote/demote (indent/outdent) + sibling parity

- **Status**: OPEN — **scoped from owner UX feedback + research (2026-07-22)**, not started. Owner reported the Tier-2 parent/child editing is "clunky": indentation is good, but there is **no keyboard way to add a child vs a sibling, and no promote/demote** to re-place an existing entry in the hierarchy (the way outliners do). Filed after a web survey + codebase read; awaiting owner go on the keybinding choice (§1) before build.
- **Milestone**: M7 (canvas/architecture UX). **Follows**: 084 (typed add-child), 102/104 (add-child grammar).

## Context (what exists)

- Tree nesting is a pure projection of `parentId` — `src/domain/entryTree.ts` (`buildEntryTree`/`flattenEntryTree`) derives `depth`; `base.css` renders it as `calc(var(--depth) * var(--space-5))` on `.t2-tree` + `td.t2-col--name`. **Reparent → re-indent is automatic; zero separate visual work.**
- The grid's keyboard grammar (`EditableGrid.tsx`, `ui/inline-editor.tsx`) is firmly committed: while EDITING, **Tab = commit + next cell**, **Enter = commit + advance down**; on a RESTING cell, arrows navigate + Enter opens the editor. Crucially the grid **ignores all Cmd/Ctrl/Alt-modified keys** (`handleGridArrowKeys` early-returns on `e.metaKey`) and the text editors only handle Enter/Tab/Escape — so **modifier chords are entirely free** in both states.
- Add-child today = the typed inline phantom (`addingChildTo`→`renderAddChildCell`, 084/102/104). Functional but no promote/demote at all; add-child ≠ add-sibling.

## Recommendation

### 1. Keyboard model (the crux — needs owner confirm)
**Do NOT overload Tab/Shift+Tab for indent/outdent.** Here Tab is load-bearing (commit + horizontal cell traversal) and a WCAG 2.1.1/2.1.2 focus key; native outliners (Workflowy/Notion/Roam/Logseq/Tana) repurpose Tab only because they have no form tab-order to honor. Instead bind **`⌘]` / `⌘[`** (Ctrl+]/Ctrl+[ on Win/Linux) — the Google-Docs / macOS indent-outdent convention — which is **already inert in the grid** (Cmd-modified keys are ignored everywhere), so it coexists with Tab=cell-move **with zero conflict, working identically at rest AND mid-text-edit**:
- **`⌘]` demote/indent** → make the entry the **last child of its immediately-preceding visible sibling** (no-op if first child).
- **`⌘[` promote/outdent** → make it a **sibling of its parent, immediately after the parent** (no-op at top level); its subtree travels with it (adopt-existing-subtree only).
- **`⌥⇧↑ / ⌥⇧↓`** → reorder among siblings.
- (Optional later: Tab/Shift+Tab as a secondary alias on the RESTING name cell only.)

### 2. Data/mutation — nearly nothing new
`moveTier2Entry(db, tableId, id, newParentId, toIndex)` **already exists + is unit-tested** (`src/db/mutations.ts:1708`; `tier2.test.ts:106` "children follow their parent") — reparents + resorts both sibling groups, subtree intact. It is **not yet exposed by the store.** Only new code: a thin `moveEntry(tableId, id, newParentId, toIndex)` in `src/store/tier2.ts` wrapping it with ONE `commandLog` push (mirror `reorderTable` at `tier2.ts:340`) + sync enqueue (`enqueueSortDeltas` + `enqueueIfSyncing(...,'update', movedRow)` for the changed `parentId`). Indent/outdent targets are computed from the flat tree already in `ArchitectureSurface.tsx` (`metaById`/`flat`).

### 3. Build, don't adopt a library
The reparent engine exists + is tested; the rest is a store wrapper + a few keydown handlers. Every candidate (`react-arborist`, `react-complex-tree`/`@headless-tree`, `dnd-kit` sortable-tree) OWNS focus and/or rendering and would fight the bespoke grid's editing/focus layer; `react-sortable-tree`/`@atlaskit/tree` are deprecated. Use ProseMirror's `sinkListItem`/`liftListItem` + the W3C tree pattern only as the **reference algorithm** (demote = sink under preceding sibling; promote = lift to parent level), not as dependencies.

### 4. A11y + undo
- One `commandLog.push` per gesture = one undo step.
- Announce every reparent via `useStatusStore.getState().announce(...)` ("Indented Buyers under Users", "Outdented Superstars").
- Add tree semantics the surface currently lacks: `aria-level` (= depth+1) + `aria-expanded` on rows with children (selection already uses `role="listbox"`).
- Expose promote/demote in the row-action gutter too (not keyboard-only). Escape still exits editing + restores native Tab.

## Phased build plan
- **P1 (biggest win):** `moveEntry` store wrapper + `⌘]`/`⌘[` indent/outdent on the focused entry, with first-child/top-level guards, undo, announce. Works mid-edit and at rest.
- **P2 (sibling parity):** **Enter = new sibling at the current entry's depth** (call `addEntry` with the current entry's `parentId`, not just the top-level phantom) — symmetric with typed add-child.
- **P3:** `⌥⇧↑/↓` move among siblings (`moveEntry`, `toIndex ± 1`).
- **P4:** tree ARIA + visible row-menu affordance + quiet `KeyHint` chips teaching `⌘]`/`⌘[` (reuse 084-D3 P5 hint pattern).

## Test-first plan
- `tier2.test.ts`: `moveEntry` reparents + resorts + one undo entry reverses it; sync enqueue asserted.
- e2e (`architecture.spec.ts`): focus an entry, `⌘]` indents it under the preceding sibling (depth+1, still visible); `⌘[` outdents; guards no-op at boundaries; Enter creates a sibling at the same depth; undo reverses each in one step.

## Open question (owner)
Confirm the primary binding: **`⌘]`/`⌘[`** (recommended — conflict-free, Google-Docs-familiar) vs Tab/Shift+Tab (familiar to outliner users but conflicts with the app's committed Tab=commit+move grammar and WCAG focus semantics). Recommendation: ship `⌘]`/`⌘[` first; add resting-cell Tab/Shift+Tab as a later alias if wanted.

*Sources: Workflowy, Notion, Roam, Logseq, Tana, Dynalist, OmniOutliner, Org-mode, Google Docs indent, WCAG 2.1.1/2.1.2; libs react-arborist, react-complex-tree/headless-tree, dnd-kit, react-sortable-tree (dep.), @atlaskit/tree (dep.), Lexical, ProseMirror/TipTap sink/liftListItem.*
