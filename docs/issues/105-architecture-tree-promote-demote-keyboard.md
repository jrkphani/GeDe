# 105: Architecture tree — keyboard tree-building (sibling/child, promote/demote) + row-command IA

- **Status**: IN PROGRESS — scoped from owner UX feedback + web research + an end-to-end red-team (2026-07-22). **Owner decisions made (2026-07-22): build P0–P3; promote/demote binding = `⌘]`/`⌘[`.** P0+P1 (kill the sub-child bug + Enter=sibling) building first, then P2+P3 (`⌘]`/`⌘[` + move). The Tier-2 parent/child editing is clunky: no keyboard way to add a sibling vs a child, no promote/demote, an accidental sub-child bug, and row *controls* live inside data cells.
- **Milestone**: M7 (canvas/architecture UX). **Follows**: 084 (typed add-child), 102/104 (add-child grammar), 025/035 (selection bar).

## Context (what exists)

- Tree nesting is a pure projection of `parentId` — `src/domain/entryTree.ts` (`buildEntryTree`/`flattenEntryTree`) derives `depth`; `base.css` renders it as `calc(var(--depth) * var(--space-5))` on `.t2-tree` + `td.t2-col--name`. **Reparent → re-indent is automatic; zero separate visual work.**
- The committed grid grammar (`EditableGrid.tsx`, `ui/inline-editor.tsx`): while EDITING, **Tab = commit + next cell**, **Enter = commit + advance DOWN**; at REST, arrows navigate + Enter opens the editor. The grid **ignores all Cmd/Ctrl/Alt-modified keys** (`handleGridArrowKeys` early-returns on `e.metaKey`) and text editors handle only Enter/Tab/Esc — so **modifier chords are entirely free**.
- The reparent engine **already exists + is unit-tested**: `moveTier2Entry(db, tableId, id, newParentId, toIndex)` (`src/db/mutations.ts:1708`; `tier2.test.ts:106` "children follow their parent") reparents + resorts both sibling groups, subtree intact — but it is **not yet exposed by the store**.
- Add-child today = the typed inline phantom (`addingChildTo`→`renderAddChildCell`, 084/102/104), triggered by a `<Button className="t2-add-child-trigger">` in the trailing `actions` static cell (`ArchitectureSurface.tsx:558-571`). Remove lives in the checkbox-select **selection bar** (025/035).

## The problem (three owner critiques, one root cause)

1. **No keyboard sibling series; an accidental sub-child.** The grid Tab-order is only `name → description` (tree/actions are `static`). But **Tab inside the description richtext is never intercepted** (`rich-text-editor.tsx:173-202` binds only Cmd+Enter/Esc/B/I/U), so it falls through to **native browser Tab** → the next focusable is the **"Add child" `<button>`** → Enter/Space arms add-child → a child (a **grandchild** if the row is already a child). There is **no keyboard path to add a sibling at depth ≥ 1** (only the depth-0 bottom phantom, and the mouse-armed add-child phantom). *This is the owner's "how do I keep making siblings by keyboard" + "why does Enter make a sub-child" — reproduced.*
2. **A control lives in a data cell.** "Add child" is a row *command*, not data; putting a focusable `<button>` in a `<td>` is the *mechanism* of #1 (tab-order pollution), conflates command with content for AT, and competes with data.
3. **Row commands are scattered by scope.** Add-child is a per-row hover button; Remove is select→selection-bar. Two mental models; a single-row delete is forced through multi-select.

## Recommendation

### A. Keyboard model — extend the grammar, don't overload Tab
Keep **Tab = commit + next cell** and **Enter = commit + continue**; add tree verbs on the free modifier space (`⌘]`/`⌘[`, `⌥⇧↑/↓` are inert in the grid today). **Do NOT repurpose Tab for indent** — here Tab is load-bearing + a WCAG 2.1.1/2.1.2 focus key (outliners repurpose Tab only because they have no form tab-order).
- **Enter** = commit + **new sibling at the current depth** (Enter-on-empty = outdent/exit). Answers the sibling-series need.
- **`⌘]` demote/indent** → last child of the immediately-preceding visible sibling (no-op if first child). **`⌘[` promote/outdent** → sibling of its parent, right after it (no-op at top level); subtree travels along.
- **`⌥⇧↑ / ⌥⇧↓`** → reorder among siblings.
- **Kill the accidental sub-child at the source** (independent of the shortcuts): **intercept Tab in the description editor** → commit + `advance('right'/'left')` (a new `onTabAdvance` seam on `RichTextEditor`), and **drop "Add child" from the tab order** (`tabIndex={-1}`).
- **Two wrinkles the model must honor:** (i) a fast series lives in a PHANTOM with no focused row, so `⌘]`/`⌘[` must mutate the **phantom's mutable `{parentId, depth}` insertion context**, not just "the focused entry"; (ii) **Enter=sibling must be Architecture-SCOPED** (an opt-in `onEnterCreateSibling` seam) — a global EditableGrid change would regress Design's register/rail + Foundation, which rely on Enter=commit+down (`EditableGrid.tsx:461-463`).

*Verified script — `Users⏎ Buyers⏎ Sellers⏎ ⌘] Superstars⏎ Casuals⏎ ⌘[ Admins⏎` builds `Users / Buyers / [Sellers, Superstars under Buyers] / Casuals / Admins`, mouse-free, mixed depths.*

### B. Row-command IA — controls belong in a gutter, not a data cell
- **Keyboard-first (primary):** the verbs above — no per-row button needed for keyboard users.
- **Mouse (secondary), OUT of the data cells:** consolidate single-row commands (Add child, Add sibling, Promote/Demote, Move, **Remove**) into ONE row-hover **`⋯` menu in a dedicated action gutter** — a real command control (`tabIndex` managed, `role` NOT `gridcell`, aria-labeled menu). Keep the 104 add-child phantom as the mouse create-path — don't delete it. NB the **empty-space-armed** behavior is DECIDED kept as-is (104 owner decision, 2026-07-22) — do NOT "fix" it. P1's insertion context supersedes the old Tab→depth-0 jump.
- **Bulk stays on the selection bar (025/035):** the checkbox-select → selection-bar pattern is correct for BULK multi-select (bulk Remove/Promote) — keep it. This app's selection is the role-gated PROMOTE-candidate multi-select, so the bar stays promote/bulk-focused. `Remove` appears in BOTH the row `⋯` menu (one row) and the bar (bulk) — same verb, two scopes.
- **Grid seam:** `EditableGrid` owns `<tr>/<td>`, so a clean "row affordance outside the cell model" wants a small per-row action-SLOT seam (rendered as an overlay/gutter, not a cell). Cheap 80% = `tabIndex={-1}` + menu-trigger (this also *is* the P0 fix for #1); clean = the gutter seam + consolidated `⋯` menu.

### C. Data/mutation — nearly nothing new
Only a thin `moveEntry(tableId, id, newParentId, toIndex)` in `src/store/tier2.ts` wrapping the existing `moveTier2Entry` with ONE `commandLog` push (mirror `reorderTable` at `tier2.ts:340`) + sync enqueue (`enqueueSortDeltas` + `enqueueIfSyncing(...,'update', movedRow)` for the changed `parentId`). Indent/outdent targets are computed from the flat tree already in `ArchitectureSurface.tsx` (`metaById`/`flat`).

### D. Build, don't adopt a library
The reparent engine exists + is tested; the rest is a store wrapper + keydown handlers. Every candidate (`react-arborist`, `react-complex-tree`/`@headless-tree`, `dnd-kit` sortable-tree) OWNS focus and/or rendering and would fight the bespoke grid; `react-sortable-tree`/`@atlaskit/tree` are deprecated. Use ProseMirror `sinkListItem`/`liftListItem` + the W3C tree pattern only as the **reference algorithm**, not dependencies.

### E. A11y + undo
One `commandLog.push` per gesture = one undo step. Announce every reparent via `useStatusStore.getState().announce(...)` ("Indented Buyers under Users", "New sibling at level 2"). Add the tree semantics the surface lacks: `aria-level` (= depth+1) + `aria-expanded` on rows with children (selection already uses `role="listbox"`). No keyboard trap — Escape still exits editing.

### F. Load-bearing invariants to PRESERVE (do not regress)
- **102's arm-suppression + 104's `beginEditing` seam are load-bearing** — arming add-child while a cell is mid-edit still suppresses that editor; a new edit while armed dismisses the phantom. P0/P1's Tab/Enter changes must not break these (`RichTextCell` deliberately keeps `editing` on blur for the FormatStrip — do not "fix" that).
- **`ArchitectureSurface` also renders on the CANVAS** (084-D3 per-table nodes) with **cross-node Tab** at the grid boundary via the `onExitBoundary` seam (089-D3). Intercepting Tab in the description is INTRA-grid (commit + advance to the next cell), so it must not swallow the boundary Tab that hands off between canvas table nodes — the `d3-canvas.spec.ts` cross-node-Tab test must stay green. Enter=sibling is Architecture-scoped and applies on BOTH hosts (fallback + canvas).

## Phased build plan (single ordered list)

- **P0 — kill the accidental sub-child (do FIRST; the actual owner-reported bug).** Intercept Tab in the description richtext (commit + advance, not native fallthrough) + `tabIndex={-1}` on the "Add child" button. Small, high-value, no new grammar.
- **P1 — sibling series.** `Enter = new sibling at the current depth` via an Architecture-scoped `onEnterCreateSibling` opt-in seam (NOT a global EditableGrid change), with the phantom carrying a mutable `{parentId, depth}` insertion context.
- **P2 — promote/demote.** `moveEntry` store wrapper + `⌘]`/`⌘[` operating on BOTH the focused resting entry AND the phantom's insertion context; first-child/top-level guards, one undo step, announce.
- **P3 — move.** `⌥⇧↑/↓` reorder among siblings (`moveEntry`, `toIndex ± 1`).
- **P4 — teach + a11y.** Tree ARIA (`aria-level`/`aria-expanded`) + quiet `KeyHint` chips (`⏎`=sibling / `⌘]`=child, reuse 084-D3 P5 pattern).
- **P5 — row-command IA consolidation.** The `⋯` row-action gutter menu (single-row commands incl. Remove); leave the selection bar for bulk/promote. (Its cheap prerequisite — Add-child `tabIndex={-1}` + menu-trigger — already ships in P0.)

## Test-first plan
- **P0:** e2e — editing a description, Tab commits + moves to the next cell/row and does NOT focus/arm "Add child"; a fast Tab run never creates a sub-child.
- **P1:** e2e — Enter in a name/phantom creates a SIBLING at the current depth (not a child, not down-nav); a run of Enters builds N siblings at depth ≥ 1.
- **P2:** `tier2.test.ts` — `moveEntry` reparents + resorts + one undo entry reverses it; sync enqueue asserted. e2e — `⌘]` indents under the preceding sibling (depth+1, still visible), `⌘[` outdents, guards no-op at boundaries, one-step undo; `⌘]` on the phantom's insertion context continues the series at the new depth.
- **P3:** `⌥⇧↑/↓` reorders; undo reverses.
- **P4/P5:** axe/ARIA lock (`aria-level`/`aria-expanded`); `⋯` menu opens with the row commands, Remove works one-row, selection bar still does bulk; the menu trigger is not a grid tab-stop.

## Owner decisions (2026-07-22 — RESOLVED)
1. **Promote/demote binding = `⌘]`/`⌘[`** ✅ (over Tab/Shift+Tab). Optional resting-cell Tab/Shift+Tab alias may be added later.
2. **Scope = build P0–P3** ✅ (P0 sub-child fix → P1 Enter=sibling → P2 `⌘]`/`⌘[` promote/demote → P3 `⌥⇧↑/↓` move). P4 (ARIA/hints) + P5 (`⋯`-gutter menu IA consolidation) follow after.
3. **Sequencing:** P0+P1 first (the reported pain), then P2+P3. The cheap P0 (`tabIndex={-1}` + intercept-Tab) ships within P0; the full `⋯`-gutter menu is P5 (later).

*Sources: Workflowy, Notion, Roam, Logseq, Tana, Dynalist, OmniOutliner, Org-mode, Google Docs indent, macOS Finder, WCAG 2.1.1/2.1.2; libs react-arborist, react-complex-tree/headless-tree, dnd-kit, react-sortable-tree (dep.), @atlaskit/tree (dep.), Lexical, ProseMirror/TipTap sink/liftListItem.*
