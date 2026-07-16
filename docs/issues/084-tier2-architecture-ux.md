# 084: 2nd Tier — Architecture UX — stable, consistent, keyboard-fast table + entry authoring

- **Status**: OPEN — audited, not started.
- **Milestone**: M6 (UI polish, same track as 013/021/024/027/081/082) — no sync/infra blocker. Architecture-route surgery only; no schema, no synced-column ripple.
- **Blocked by**: **Sequence after 083** (the tier editing lockout / role-gate bug) — 083 restores the add affordance's *presence*; 084 improves the *shape* of that affordance. Landing 084 first would polish a control that a locked-out user can't see. Can and should **share 082's unified grid grammar** (its `EditableChainProvider` / `EditableGrid` keyboard contract) rather than inventing a parallel one — Direction 3 below depends on that.

> **Not in scope:** the functional "add-table doesn't work" lockout (role gate + fire-and-forget silent add) is filed separately as **083** and is a prerequisite, not part of this issue. 084 is UX-only. See 083 for the functional bug.

## User story

As a designer building the 2nd Tier — Architecture, I want to **pour in as many tables and nested entries as I like in the shortest time, entirely from the keyboard**, on a surface that reads as one coherent instrument with Foundation and Design. Today the add-table affordance is a faint ghost with no empty-state guidance, there are two different "Add table" controls that behave differently, the keyboard flow dead-ends between a table's last entry and the next table, and adding a child row inserts a literal `'New entry'` I then have to hunt down and rename. Each of these is small; together they fight the north star.

## The north star (yardstick for every decision)

**Get the user to enter as much information as they like in the shortest time**, consistent with Foundation (tier 1) and Design (tier 2 canvas). This is the same yardstick 082 uses for the Design route; 084 applies it to the Architecture route.

## Investigation summary (verified file:line findings)

All references are to `src/components/ArchitectureSurface.tsx` unless noted. The add/edit primitives themselves are correct (see 083 for the data-path trace); these are UX/IA/consistency findings.

- **Empty-state is a bare ghost with no guidance.** `:84-93` — when `tables` is empty the surface is just the `h2` header (`:76`) plus a single faint placeholder input reading "Add table" (`:86-91`). No heading, no orienting copy, no example dimension names. A first-time user on an empty project has almost nothing actionable.
- **Two competing "Add table" affordances with different grammar.** A context-bar "Add table" button at `:66-72` only **focuses** the ghost input (`:69`, `addTableRef.current?.querySelector('input')?.focus()`) — it does not create anything — while the ghost input at `:86` is the actual create control. Same object, two affordances, two grammars. This is exactly the "different add grammars within inches of each other" complaint 082 is fixing on the Design route (082 doc lines 22-30).
- **Keyboard-only rapid entry dead-ends at the table boundary.** Within a table, `EditableGrid` has the strong Numbers grammar — Enter-commits-down, Tab-commits-right, Tab-from-phantom creates-and-continues (`EditableGrid.tsx:300-307,594-608`). But the add-table input at `:86` is the standalone `PhantomInput` (`inline-editor.tsx:125-161`), which has **no Tab-across chain**, and there is **no keyboard bridge from a table's last entry to the add-table input**. So "add table → fill it → add next table" cannot be completed without the mouse — directly against the north star.
- **Add-child inserts a hardcoded name instead of typed entry.** `:254-261` — the row "+" action calls `addEntry(table.id, entry.id, 'New entry')` with a literal string, then relies on the user to find and rename the junk row. Every *other* add on this surface is type-first (phantom). Inconsistent and higher-cost (create → locate → rename vs type → Enter).
- **`t2-contextbar` is a bespoke pattern not mirrored in Foundation.** `:53-73` — the quick-jump list is a good IA touch, but Foundation has no context bar (SITEMAP §2 leaves it empty), and folding a create pseudo-button into a *navigate* bar blurs "jump to" vs "create."
- **Raw pixel inline style — STYLE_GUIDE §11 token violation.** `:182` — `style={{ paddingLeft: meta.depth * 24 }}` hardcodes a `24` px literal in JSX; §11 mandates spacing via `var(--…)` tokens.
- **querySelector-based focus is fragile a11y wiring.** `:69` — the "Add table" button reaches into the DOM with `querySelector('input')` to move focus. It works, but bypasses React focus management and focuses nothing when the add section is role-hidden at `:84` (a dead control for viewers — see 083 for the role gate).
- **Selection semantics: `aria-pressed` buttons, not a listbox.** `:198-206` — the per-row select control is an `aria-pressed` toggle button. A screen-reader user hears "pressed / not pressed," not "selected, 2 of 5" — weaker semantics for the multi-select that the promote flow (`:333-343,398-500`) depends on.

## Design brief

Two things must improve together: **a stable, guided add point**, and **one keyboard grammar that never dead-ends**. Both should converge with 082's Design-route work rather than diverge from it.

- **Give creation a stable home and a real empty state.** The add-table point should not be a faint trailing ghost with no copy; it should be an anchored, labeled affordance with one line of orienting guidance when the surface is empty (mirror Design's "Bind your first context", `Canvas.tsx:415-426`).
- **One add grammar for tables and entries.** Collapse the two "Add table" controls (`:66-72` vs `:86`) into a single typed create path, and make add-child (`:254-261`) a typed phantom child row instead of inserting `'New entry'`.
- **Keyboard flow that spans the whole surface.** Tab/Enter should carry from a table's last entry into the add-table point and into a freshly-created table's first entry — the same "creates-and-continues" contract `EditableGrid` already has internally (`:594-608,714-749`).
- **Token + a11y hygiene.** Replace the raw `24px` indent with a token; harden focus wiring; consider listbox selection semantics for the promote multi-select.

## Ranked UX findings (by leverage)

1. **(Highest) Empty-state ghost with no guidance** — `:84-93`. Add a labeled primary affordance + one orienting line for the empty project. Closes the "nothing actionable" first-run gap.
2. **Two competing add affordances** — `:66-72` (focus-only button) vs `:86` (real create). Unify into one grammar; removes the "same object, two behaviors" friction (mirrors 082).
3. **Keyboard dead-end at the table boundary** — the `:86` `PhantomInput` has no Tab-across, and no bridge from a table's last entry. Wire the create-and-continue chain end to end (reuse `EditableGrid.tsx:594-608,714-749`).
4. **Add-child hardcodes `'New entry'`** — `:254-261`. Open an inline typed child phantom instead. Consistency + lower interaction cost.
5. **`t2-contextbar` inconsistency vs Foundation** — `:53-73`. Keep the jump list; move creation out of the navigate bar.
6. **(§11) Raw `paddingLeft: meta.depth * 24`** — `:182`. Drive indentation from a `--space-*` token (e.g. a CSS custom property fed by the existing `data-depth` at `:182`).
7. **(§10) querySelector focus fragility** — `:69`. Use a ref to the input element; hide/disable the button under role-hidden state.
8. **(§10) `aria-pressed` vs listbox selection** — `:198-206`. Consider `role="option"` / `aria-selected` in a labeled listbox for the promote multi-select.

**No raw `<button>` / unwrapped-primitive violations found** — all controls go through `ui/button`, `ui/input`, `ui/popover`, `ui/inline-editor` (STYLE_GUIDE §11 satisfied except finding 6).

## Visual directions

### Direction 1 — Persistent add row at the top (lowest risk)

Move creation out of the context bar into a fixed, always-visible typed row under the header; tables stack below it.

```
Empty state                              Populated (2+ tables)
┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐
│ 2nd Tier · Architecture             │  │ 2nd Tier · Architecture             │
├─────────────────────────────────────┤  ├─────────────────────────────────────┤
│ ＋ Name a table…            [enter] │  │ ＋ Name a table…            [enter] │
├─────────────────────────────────────┤  ├─────────────────────────────────────┤
│                                     │  │ ▸ Stakeholders            2 entries  │
│   No tables yet. Name your first    │  │   ┌───────────────────────────────┐ │
│   dimension above — e.g.            │  │   │ ⌄ Users            → Persona   │ │
│   "Stakeholders", "Value".          │  │   │   Name an entry…              │ │
│                                     │  │   └───────────────────────────────┘ │
│                                     │  │ ▸ Value                   0 entries  │
└─────────────────────────────────────┘  └─────────────────────────────────────┘
```

*Interaction cost:* 1 action (type + Enter); input never relocates. *Pros:* fixes findings 1, 2, 5; the add point is stable and obvious; trivial to build. *Cons:* the add row sits above content, slightly less "document-like" than a trailing ghost.

### Direction 2 — Trailing ghost + real empty state + Tab-chain (keeps current placement)

Keep the ghost at the bottom, but give it a labeled empty state and wire the keyboard chain end to end.

```
Empty state                              Populated (2+ tables)
┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐
│ 2nd Tier · Architecture             │  │ 2nd Tier · Architecture             │
├─────────────────────────────────────┤  │ [Stakeholders] [Value]   ＋ add     │
│  ╭─ Start your architecture ──────╮ │  ├─────────────────────────────────────┤
│  │ A table per dimension you want │ │  │ Stakeholders              2 entries  │
│  │ to reason about.               │ │  │  Users            → Persona          │
│  │                                │ │  │  ⌊ Name an entry…                    │
│  │ ＋ Name a table…       [enter] │ │  │ Value                     1 entry    │
│  ╰────────────────────────────────╯ │  │  Speed                               │
│                                     │  │ ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈ │
│                                     │  │ ＋ Name another table…      [enter]  │
└─────────────────────────────────────┘  └─────────────────────────────────────┘
```

*Interaction cost:* Tab from a table's last entry lands on the next add point; full keyboard flow. *Pros:* fixes 1, 3; preserves the "document grows downward" feel the design brief likes; minimal layout change. *Cons:* the add point still moves down as tables accumulate (mitigated by the context-bar jump list at `:53-73`).

### Direction 3 — Unify onto the grid grammar (highest leverage; coordinate with 082)

Make tables themselves rows in an outer `EditableGrid` (columns: name · entry-count · actions), phantom row = "type to add a table." A table row expands to its own inner grid. This makes Tier-2 add-table byte-identical to add-entry **and** to 082's unified Design grammar.

```
┌─────────────────────────────────────────────────┐
│ 2nd Tier · Architecture                          │
├──────────────┬──────────┬───────────────────────┤
│ Table        │ Entries  │                       │
├──────────────┼──────────┼───────────────────────┤
│ ▾ Stakeholders│ 2       │        (expanded)     │
│    ┌ Users            → Persona                  │
│    ⌊ Name an entry…                              │
│ ▸ Value      │ 1        │                        │
│ ＋ Name a table…  ← same phantom grammar as rows │
└──────────────┴──────────┴───────────────────────┘
```

*Interaction cost:* one grammar for tables, entries, and (per 082) dimensions/params — nothing new to learn. *Pros:* maximal consistency (findings 2, 3, 4, 5); one code path; keyboard-complete via the shared contract. *Cons:* biggest refactor — nested grid-in-grid interaction, and the selection/promote bar (`:333-343`) needs rehoming. **Must reuse 082's `EditableChainProvider` / grid keyboard grammar**, not a parallel implementation; sequence after 082 lands that shared seam.

## Test-first plan (red first)

**Phase 1 (empty state + one add grammar — Directions 1/2):**
1. **Empty-state guidance** — `src/components/ArchitectureSurface.test.tsx`: with `tables` empty, the surface renders a labeled add affordance **and** orienting copy (not just a bare placeholder input). Red today: `:84-93` renders only the ghost input.
2. **Single add grammar** — assert there is one create path for a table (type + Enter, clears, refocuses), and the context-bar control does not present a second, differently-behaving "add." Red today: `:66-72` (focus-only) coexists with `:86` (create).
3. **Typed add-child** — `:254-261` opens an inline typed child phantom rather than inserting a literal `'New entry'` row. Red today.

**Phase 2 (keyboard chain — Direction 2/3):**
4. **Keyboard bridge across the table boundary** — from a table's last entry, Tab/Enter reaches the add-table input; creating a table continues into its first entry (reuse `EditableGrid.tsx:594-608,714-749`). Red today: the `:86` `PhantomInput` has no Tab-across and no cross-table bridge.
5. **Grid-unification parity (if Direction 3)** — `src/components/EditableGrid.test.tsx`: tables rendered as grid rows inherit the full Enter-down / Tab-right / Tab-creates-and-continues / Esc-revert contract; shares 082's grammar seam. Red today.

**Throughout (hygiene):**
6. **Token indent** — no raw pixel literal for tree depth; indentation derives from a `--space-*` token off `data-depth` (`:182`). Red today (`paddingLeft: meta.depth * 24`).
7. **Focus + a11y** — the add-table focus affordance uses a ref (not `querySelector`) and is absent/disabled under the role-hidden state (`:69`); promote multi-select carries listbox/selected semantics (`:198-206`). Red today.

Standing gate: `npm run verify:fast` green (`npx tsc --noEmit`, `npx eslint . --quiet`, `npx stylelint`, vitest).

## Acceptance criteria

- [ ] **Empty state** — an empty Architecture surface shows a labeled add affordance plus one line of orienting guidance (finding 1). Test 1 passes.
- [ ] **One add grammar** — a table is created via a single typed "type + Enter, clears, refocuses" path; no second differently-behaving "Add table" control remains (finding 2). Test 2 passes.
- [ ] **Typed add-child** — adding a child opens an inline typed phantom, never inserts a literal `'New entry'` (finding 4). Test 3 passes.
- [ ] **Keyboard never dead-ends** — Tab/Enter carries from a table's last entry to the add-table point and into a new table's first entry, no mouse required (finding 3). Test 4 passes.
- [ ] **(Optional, Direction 3)** — tables render on the shared `EditableGrid`/`EditableChainProvider` grammar, byte-identical with entries and with 082's Design route. Test 5 passes.
- [ ] **Token + a11y hygiene** — no raw pixel indent (finding 6); ref-based focus, role-aware (finding 7); listbox selection semantics (finding 8). Tests 6-7 pass.
- [ ] **Consistency** — the create control is out of the `t2-contextbar` navigate list; the jump list remains (finding 5).
- [ ] **No functional regression to 083** — 084 does not re-introduce or depend on the role-gate/fire-and-forget behavior; the add affordance's *presence* is 083's job. `verify:fast` green.

## Open questions (genuine design forks — answers change the build)

1. **Add-table placement:** a stable row at the **top** (Direction 1) or a trailing **ghost at the bottom** (Direction 2)? This forks the layout and the keyboard-chain wiring.
2. **How far to unify:** ship the low-risk fix now (D1/D2), or invest in grid-unification (D3) so Tier-2 tables share one grammar with Tier-2 entries **and** 082's Design route? D3 only pays off if built on 082's shared grammar seam.
3. **Add-child behavior (finding 4):** keep "insert `'New entry'`, then rename" (`:254-261`), or switch to an inline typed child row? The latter matches every other add but changes the "+"-button interaction.
4. **Selection semantics (finding 8):** is the promote multi-select worth re-expressing as a labeled listbox (`role="option"`/`aria-selected`), or is the current `aria-pressed` toggle acceptable for this slice?

## Addendum (2026-07-16): the per-row **delete/trash** control + resolution popover (the audit's blind spot)

The audit above documents the per-row **add-child "+"** (finding 4) but never the **delete "trash"** control that sits right beside it. Both live in the same right-aligned meta cell, so a critique of "controls crammed into the table rows" is incomplete without the delete half.

- **Two icon-only controls co-inhabit one right-aligned `.t2-meta` cell**, alongside the `→ dimensionName` promoted-source badge. `src/components/ArchitectureSurface.tsx:232-296` defines the `meta` column; `.t2-meta` is `justify-content: flex-end` (`base.css:2183-2189`). On hover, up to **three** things (source badge, `+`, trash) compete in a ~40px-min strip on **every** entry row.
- **Add-sub-row "+"** — `:250-264`. `onClick` un-collapses the parent (`setCollapsed`) then fires `addEntry(table.id, entry.id, 'New entry')` — the hardcoded literal already captured as finding 4.
- **Delete "trash"** — `:265-289` (NEW; not in the audit above). `onClick` → `handleDelete(entry)` (`:161-168`) → `removeEntry(table.id, entry.id)`. If the entry was promoted to a Tier-3 parameter (invariant 7) the store returns `needs-resolution`, which sets `resolving` state (`:119`) and opens an inline `ResolutionPopover` (`:348-396`) **anchored to the trash button**, offering "Keep parameter as unlinked copy" (`resolveKeep`) vs "Delete parameter — unbinds N contexts" (`resolveDeleteParams`); otherwise it announces `Deleted {name}`. So delete is never silent, but it fires a **destructive, cascade-carrying popover from inside a data-grid cell**.
- **Both are hover/focus-revealed, not always-on** — `.t2-row-action { visibility: hidden }`, shown only on `.t2-table tbody tr:hover` / `:focus-visible` (`base.css:2197-2214`). Milder than always-on clutter, but the two affordances still stack per row, and the destructive one shares the hover strip with a create one.
- **Both gated by `readOnly`** (`:248`, the 083/035 role gate) — viewers never see them.

**Divergence from the 085 Design editing-zone model** (shipped, `done/085-design-route-consolidated-editing.md`): `DesignSurface.tsx` has **no** per-row add/delete icon buttons inside grid cells at all. Deletion in Design is a quiet text **"Remove"** `rowAction` in the dimension rail (`ParameterList.tsx:67-72`, STYLE_GUIDE §2.2/§6 — quiet until row hover/focus), and adds are type-first phantoms. So Architecture's grid-cell-embedded destructive **icon** + inline resolution popover has no analogue in the cleaner model 085 established for the sibling route — it should be reconsidered alongside the add-child unification, not treated as settled.

**New ranked finding (slots beside finding 4):**
- **4b. Destructive delete icon + resolution popover embedded in the grid cell** — `:265-289`, `:161-168`, `:348-396`, CSS `:2197-2214`. A cascade-carrying destructive action fires from inside a data-grid row cell, sharing the hover strip with the create "+". Consider moving row deletion to the same quiet-text `rowAction` pattern the Design route uses (`ParameterList.tsx:67-72`) rather than a per-cell trash icon, and rehoming the linked-parameter resolution to a less cramped surface.

**New open question (extends fork 3):** should the row **delete** affordance follow Design's quiet-text "Remove" `rowAction` (moving the destructive control + resolution flow out of the `.t2-meta` icon strip), or stay a per-row trash icon? This forks together with the add-child grammar decision, since both controls share the one meta cell.

## References

- Code (audited, verified file:line): `src/components/ArchitectureSurface.tsx:53-73,66-72,69,84-93,86-91,182,198-206,254-261,320,327-332,333-343,398-500`, `src/components/FoundationSurface.tsx:196-214`, `src/components/EditableGrid.tsx:300-307,565-614,594-608,668,714-749`, `src/components/ui/inline-editor.tsx:125-161`, `src/components/Canvas.tsx:415-426` (empty-state precedent).
- `docs/STYLE_GUIDE.md` §1 (in-place editing, drafting restraint), §2.2 (`command` vs `rowAction` variants), §6 (Numbers grammar: "New row = start typing in the phantom row"; Enter-down, Tab-right, Esc-revert), §10 (a11y baseline — focus order, labeled controls), §11 (token/component enforcement — `var(--…)` only) · `docs/SITEMAP.md` §2 (per-surface context bar; Foundation's bar is empty) · `docs/SPEC.md` §4.6 (2nd Tier Architecture, invariant 7 tier-linkage).
- Related issues: **083** (tier editing lockout / role gate — the prerequisite functional fix; 084 must not re-cover it), **082** (Design-route UX — the unified phantom-row grammar / `EditableChainProvider` seam 084's Direction 3 should share), `done/024` (EditableGrid table legibility), `done/027` (context-bar three-group layout).
