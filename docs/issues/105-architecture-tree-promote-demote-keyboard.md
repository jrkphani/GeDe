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

## Red-team findings (end-to-end trace, 2026-07-22) — REORDERS the plan

An adversarial end-to-end trace (from owner feedback: "Tab keeps landing me on Add-child and Enter there makes a SUB-child; how do I keep making SIBLINGS of a child by keyboard?") found **`⌘]`/`⌘[` alone does NOT fix the owner's complaint**, and surfaced three things the original plan missed:

1. **The actual bug is a Tab-FALLTHROUGH, not a missing shortcut.** Row Tab-order managed by the grid is only `name → description` (tree/actions are `static` cells). But **Tab inside the description richtext is deliberately never intercepted** (`rich-text-editor.tsx:173-202` binds only Cmd+Enter/Esc/Cmd+B/I/U), so it falls through to **native browser Tab** → the next focusable is the **"Add child" `<button>`** in the same row (`ArchitectureSurface.tsx:558-571`); Enter/Space there → `setAddingChildTo(entry.id)` → a child (a grandchild if the row is already a child). **This is the sub-child bug, reproduced.** The fix is (a) **intercept Tab in the description editor** → commit + `advance('right'/'left')` (a new `onTabAdvance` seam on `RichTextEditor`), and (b) **drop "Add child" from the tab order** (`tabIndex={-1}`, keep it a click/hover affordance). **Neither is `⌘]`/`⌘[`** — so this must be P0, or the complaint stays live.
2. **The insertion-context wrinkle.** A fast keyboard series lives in a PHANTOM input with NO focused entry row — so `⌘]`/`⌘[` "on the focused entry" is insufficient. The phantom must carry a **mutable `{parentId, depth}` insertion context** that `⌘]` (reparent under the last-created sibling) / `⌘[` (up one level) mutate, so subsequent Enters continue at the new depth. Without this the series flow breaks.
3. **Enter=sibling MUST be Architecture-scoped, never a global EditableGrid change.** Design's register/rail + Foundation reuse EditableGrid with **Enter = commit + move DOWN** (`EditableGrid.tsx:461-463`); a blanket change regresses them. Wire an opt-in `onEnterCreateSibling` seam used ONLY by Architecture. Keep the 104 add-child phantom as the MOUSE path (fix its 2 warts: empty-space-armed; Tab→depth-0 jump) — do not delete it.

**Verified keystroke script** (target end state) — `Users⏎ Buyers⏎ Sellers⏎ ⌘] Superstars⏎ Casuals⏎ ⌘[ Admins⏎` builds:
```
Users / Buyers / [Sellers, Superstars under Buyers] / Casuals / Admins
```
mouse-free, mixed depths — proving the model works once P0+P1 land.

## Row-command placement (IA) — owner critique, 2026-07-22

**"Add child" is a CONTROL, not data — it should not live inside a data `<td>`.** Today it's a `<Button className="t2-add-child-trigger">` in the trailing `actions` static cell (`ArchitectureSurface.tsx:558-571`). That placement is the *mechanism* of the sub-child bug (a focusable button in native tab order — see red-team finding 1), conflates command with content for AT (announced as gridcell content), and competes with data. In a real outliner there is no per-row "Add child" button at all — child creation is keyboard + a bullet/⋯ context menu.

**Recommended IA:**
- **Keyboard-first (primary):** Enter=sibling / ⌘]=child (P0/P1/P2 below) — no button needed for keyboard users.
- **Mouse affordance OUT of the data cells (secondary):** consolidate ALL row commands — Add child, Add sibling, Promote/Demote, Move, Remove — into ONE row-hover **`⋯` menu in a dedicated row-action gutter**, rendered as a real command control (`tabIndex` managed, `role` NOT `gridcell`, aria-labeled menu), instead of today's split (Add-child in a cell, Remove in the selection bar — inconsistent).
- **Architectural note:** `EditableGrid` owns the `<tr>/<td>`, so a clean "row affordance outside the cell model" wants a small grid seam (a per-row action SLOT the grid renders as an overlay/gutter, not a cell). Cheap 80% version: `tabIndex={-1}` + make the existing trigger a menu button (also satisfies P0's "drop Add-child from tab order"). Clean version: the gutter seam + consolidated `⋯` menu. Sequence the cheap version into P0 and the gutter/menu consolidation as its own P (below).

### Selection-bar vs per-row menu (owner follow-up) — scope, not scatter
The checkbox-select → contextual **selection bar** (issue 025/035 — Remove/Promote appear on select) is a GOOD, standard pattern **for BULK multi-select** (Gmail/Notion/Linear/Finder). The problem is NOT the bar; it's that **single-row commands are split across two mental models**: Add-child is a per-row hover button, but Remove requires select→bar. Forcing a single-row delete through multi-select is heavyweight. Fix by separating by SCOPE:
- **Single-row commands → the per-row `⋯` menu** (Add child/sibling, Promote/Demote, Move, **Remove**), keyboard-first. One consistent home.
- **Bulk commands → the selection bar** (bulk Remove, bulk Promote) — keep it; it's correct for multi-select. This app's selection is specifically the role-gated PROMOTE-candidate multi-select (035), so the bar stays focused on promote + bulk.
- `Remove` lives in BOTH (single-row menu + bulk bar) — same verb, two scopes; expected. **New sub-phase P5:** consolidate single-row commands into the `⋯` gutter menu; leave the selection bar for bulk/promote.

## Phased build plan (reordered per the red-team)
- **P0 (the actual owner-reported fix — do FIRST):** intercept Tab in the description richtext (commit + advance, not native fallthrough) + `tabIndex={-1}` on the "Add child" button. Kills the accidental sub-child. Small, high-value, no new grammar.
- **P1 (sibling series):** **Enter = new sibling at the current depth**, via an **Architecture-scoped `onEnterCreateSibling` opt-in seam** (NOT a global EditableGrid change), with the phantom carrying a mutable `{parentId, depth}` insertion context. Answers "keep making siblings by keyboard."
- **P2 (promote/demote):** `moveEntry` store wrapper over the existing `moveTier2Entry` + `⌘]`/`⌘[` operating on BOTH the focused resting entry AND the phantom's insertion context; first-child/top-level guards, one undo step, announce.
- **P3:** `⌥⇧↑/↓` move among siblings (`moveEntry`, `toIndex ± 1`).
- **P4:** tree ARIA (`aria-level`/`aria-expanded`) + visible row-menu affordance + quiet `KeyHint` chips teaching `⏎`=sibling / `⌘]`=child (reuse 084-D3 P5 hint pattern).

## Test-first plan
- `tier2.test.ts`: `moveEntry` reparents + resorts + one undo entry reverses it; sync enqueue asserted.
- e2e (`architecture.spec.ts`): focus an entry, `⌘]` indents it under the preceding sibling (depth+1, still visible); `⌘[` outdents; guards no-op at boundaries; Enter creates a sibling at the same depth; undo reverses each in one step.

## Open question (owner)
Confirm the primary binding: **`⌘]`/`⌘[`** (recommended — conflict-free, Google-Docs-familiar) vs Tab/Shift+Tab (familiar to outliner users but conflicts with the app's committed Tab=commit+move grammar and WCAG focus semantics). Recommendation: ship `⌘]`/`⌘[` first; add resting-cell Tab/Shift+Tab as a later alias if wanted.

*Sources: Workflowy, Notion, Roam, Logseq, Tana, Dynalist, OmniOutliner, Org-mode, Google Docs indent, WCAG 2.1.1/2.1.2; libs react-arborist, react-complex-tree/headless-tree, dnd-kit, react-sortable-tree (dep.), @atlaskit/tree (dep.), Lexical, ProseMirror/TipTap sink/liftListItem.*
