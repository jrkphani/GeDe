# 093: D3 canvas — let the context register extend RIGHT instead of clipping, and re-home the "New context" affordance

- **Status**: OPEN (design writeup — no code changed). D3-canvas UX refinement. Explores the owner observation from the `?d3rf` React Flow canvas (Design lane node) that the context register clips horizontally and the "New context" button is stranded above the ring.
- **Milestone**: M6 (UI polish — same track as 082/084/085/089). Frontend + CSS only; **no schema, no migration**. Sits on top of **089-D3** (the pan/zoom canvas, spike PASSED / GO 2026-07-18, building behind the dev-only `?d3rf` flag) and the **ring-on-top "Design-lane relayout"** (owner layout, base.css 2026-07-18).
- **Relationship to 089**: this is a **D3-canvas refinement**, not a new direction. 089-D3 P0–P3.4 built the derived-position lane canvas (`laneLayout.ts` + `WorkspaceCanvas.tsx`); this issue asks whether the Design lane node should stop being a fixed-960px box and instead let its register grow horizontally into the empty canvas to its right. It does **not** re-open 089's positioning model (position stays derived; the node just measures wider).
- **Depends on / sequences after**: 089-D3 landing the Design node in `WorkspaceCanvas.tsx` (done behind the flag). Independent of 091/092.

## User story

As a designer building contexts on the D3 infinite canvas, when my project has more than a handful of dimensions I want to **see the whole context register — SYMBOL, DOCUMENTED, every dimension, JUSTIFICATION, CHILDREN, DUPLICATE — without a cramped inner horizontal scrollbar hiding the proof columns behind the frozen symbol column**, and I want the **"New context" create affordance to live where contexts actually live** (with the rows and the phantom row), not stranded at the very top of the node above a large ring. Since this is an infinite canvas, the register should be free to grow rightward and I pan to reach the far columns — the same "zoom/pan to focus" verb the canvas already gives me.

## Investigation summary (verified file:line findings)

### Why the register clips today

The register is one `EditableGrid` (`ContextRegister.tsx:249-293`) whose columns are built at `ContextRegister.tsx:123-247`:

- fixed leading columns: **Symbol** (`:124-138`), **Documented** (`:139-158`);
- **one column per dimension**, spread dynamically in dimension order (`:159-179` — `...dimensions.map(...)`), so column count grows 1:1 with the dimension count;
- fixed trailing columns: **Justification** (`:180-197`, a Lexical richtext cell), **Children** (`:198-219`), **Duplicate** (`:220-246`).

The grid renders into `<div className="register-scroll"><table className="editable-grid">` (`EditableGrid.tsx:1052-1053`). The clip is produced by three CSS rules in `src/styles/base.css`:

1. **`.register-scroll { overflow-x: auto }`** (`base.css:927-934`) — the register scrolls horizontally *inside its own panel* by design ("the page never scrolls sideways"). This is exactly the inner scrollbar the owner is hitting.
2. **`.editable-grid { width: 100%; ... }`** with the browser-default `table-layout: auto` (`base.css:936-946`), and **every `th` is `white-space: nowrap`** (`base.css:948-962`). So each column demands its header's full width on one line; as dimensions accumulate, the table's *intrinsic min-width* exceeds the container and the `overflow-x` kicks in.
3. **The frozen symbol column** — `.editable-grid td.grid-col--symbol { position: sticky; left: 0; ... box-shadow: var(--shadow-frozen-col) }` (`base.css:1010-1018`, comment `:1001-1009`) — stays pinned while everything else slides under it. This is deliberate frozen-column behavior, but it is *what makes the far columns (JUSTIFICATION / CHILDREN / DUPLICATE) disappear* when the table overflows.

The container that caps the width differs per surface:

- **D3 canvas node**: `.wc-node { width: 960px }` (`base.css:370-375`) — every lane node is a fixed 960px box. The register lives at `.wc-node__body` → `.design-surface-row` → `.editing-zone` → `.context-register-shell` → `.register-scroll`. So on the canvas the register can never be wider than ~960px minus padding, and everything past that scrolls inside `.register-scroll`.
- **D2 lane page** (`WorkspaceSurface.tsx:79-91`): the register sits in `.workspace__lane--design`; `.workspace { min-width: min-content }` (`base.css:268-274`) lets the three lanes overflow into the shared `.surface` scroll rather than compress — but the register still clips inside its own `.register-scroll`.
- **Normal single-Design route**: same `DesignSurface` → same `ContextRegister` → same `.register-scroll`.

**Root cause in one line**: `.register-scroll`'s `overflow-x: auto` (`base.css:930`) + a nowrap-header auto-layout table (`base.css:961`) inside a fixed-width container (`.wc-node` 960px, `base.css:371`) means the table's dimension-driven intrinsic width is clipped and hidden behind the sticky symbol column (`base.css:1012`).

### The "New context" affordance disconnect

The ring-on-top relayout (owner layout, `base.css:1614-1625`) made `.design-surface-row` a single **column**: `flex-direction: column; align-items: center`. Within it:

- the **ring / Canvas** is `order: -1` (`base.css:1673-1681`) — paints **on top**, a centered square `width: min(480px, 60vh, 100%)`;
- the **editing zone** (rail + register) is `order: 2` (`base.css:1631-1647`) — **below** the ring;
- the **"New context" button** is in `.canvas-toolbar` (`DesignSurface.tsx:649-658`), which is rendered **before** the `.design-surface-row` in the DOM (`DesignSurface.tsx:646-727`) and has no `order`, so it sits at the very **top** of the node — *above the ring*, `margin-bottom: var(--space-4)` (`base.css:1731-1737`).

So the vertical stack in the Design node is now: **[New context button] → [ring] → [rail | register]**. The button is separated from the register's rows AND from the register's own "New context" **phantom row** (`ContextRegister.tsx:279-291`, placeholder `'New context'` at `:282`) by the entire height of the ring. The ring-on-top relayout widened that gap — previously (side-by-side) the toolbar sat closer to the register column.

**Two create paths, and they are NOT identical** (so the top button is *not* simply redundant):

- **Toolbar "New context" button** → `enterCompose()` (`DesignSurface.tsx:654`, `enterCompose` at `:216-251`): creates a persisted draft, **selects it, and enters compose mode** — the guided dot-by-dot binding flow on the ring + register (`activeDimensionId`, `handleBindParameter`). Also bound to the **`c` key** (`DesignSurface.tsx:311-333`, SITEMAP §4 line 84).
- **Register phantom row** → `createContext()` + `setJustification(text)` batched as one undo step (`ContextRegister.tsx:283-289`): creates a draft seeded with justification prose, but **does not enter compose mode** (no guided binding pointer).

There is even a **keyboard bridge** that treats the register phantom as the canonical create endpoint: the rail's last phantom Tabs into `.context-register-shell .grid-row--phantom input` (`DesignSurface.tsx:435-457`, esp. `:448-453`). So the register phantom row is already the keyboard "create a context" home — while the *button* for the richer compose-mode create is stranded at the top.

**Finding**: the disconnect is real, but the fix is not "delete the button" — it's "reconcile two create grammars (compose-mode vs phantom-seed) and give the surviving affordance(s) a home adjacent to the register." That reconciliation is an **owner fork** (below), not a mechanical move.

### Does the canvas tolerate a variable-width Design node?

Yes, and Design is the safe lane to grow:

- `laneLayout.ts` derives x as a **pure function of tier index**: `laneX = columnIndex(tier) × (laneWidth + laneGap)` (`laneLayout.ts:61-63`), with `LANE_ORDER = ['foundation','architecture','design']` (`:26`). **Design is `LANE_ORDER[2]` — the rightmost column.** So a wider Design node grows into **empty canvas to its right** and can never overlap Foundation/Architecture (they sit at lower, fixed x).
- Crucially, `computeLaneLayout` x uses the **constant** `LANE_CONFIG.laneWidth = 960` (`WorkspaceCanvas.tsx:91`), *not* each node's measured width. So even if the Design node renders wider than 960px, **no other lane's x shifts** — the stride is a constant, and nothing sits to Design's right. (Confirmed: growing right is layout-safe precisely because Design is last and x is a constant-stride pure function, `laneLayout.ts:59-63` + comment `:23-27`.)
- React Flow sizes a node to its content **unless CSS constrains it**. Today `.wc-node { width: 960px }` (`base.css:371`) hard-caps it. Letting the register drive width means relaxing that cap **for the Design node only** (or for the register within it) and letting `node.measured.width` be whatever the content needs. Vertical stacking (`withDerivedPositions` → `computeLaneLayout`, `WorkspaceCanvas.tsx:185-201`) keys on **height** only, so a width change does not perturb the y-stack.

### The ring-vs-register width mismatch

The ring is a fixed square, `width: min(480px, 60vh, 100%)` (`base.css:1680`), and Canvas measures **`.canvas-shell`'s own width** to size the invisible 44px dot hit-targets (`base.css:1669-1672` — "a full-band-wide shell would under-size the hit circles"). The register, once it extends right, can be much wider than 480px. So they can no longer share a single centered column cleanly — **how the ring sits relative to a much-wider register is an open layout fork** (centered above / left-aligned / register-defines-width-and-ring-floats).

## Design brief

Two things improve together, both scoped to the **infinite canvas** where they make sense:

1. **The register stops clipping — it extends right and you pan to reach far columns.** On an infinite canvas a horizontal inner scrollbar is the wrong primitive: it hides the proof columns (JUSTIFICATION/CHILDREN/DUPLICATE) behind the frozen symbol column and fights the canvas's own pan verb. Let the Design node measure to the register's natural width; the far columns are reached by panning (the same viewport verb 089-D3 already ships, incl. focus-pan `WorkspaceCanvas.tsx:531-554`).
2. **The create affordance lives with the contexts.** The "New context" button should not sit at the very top of the node above a 480px ring while the rows and the phantom row are far below. Re-home it adjacent to the register (or fold it into the register's own phantom-row grammar), and reconcile the compose-mode-vs-phantom-seed split so there is one clear "make a context" story.

**Yardstick** (same as 082/084/085): *get the user to enter as much information as they like in the shortest time*, and keep D3 consistent with the derived-position, selection-not-arrangement principle (STYLE_GUIDE §1 principle 4).

## Visual directions

### Direction A — Node measures to the register; ring centered above the full width (recommended default)

Relax `.wc-node` width for the Design node; the register extends right to show all columns; the ring stays a centered square in the band above it. You pan right to reach DUPLICATE.

```
Design lane node (grows right on the infinite canvas — pan to reach far cols)
┌──────────────────────────────────────────────────────────────────────────────┐
│ ⠿ Design                                                        (drag handle)  │
├──────────────────────────────────────────────────────────────────────────────┤
│                              ╭───────────────╮                                 │
│                              │     ( ring )   │      ← centered square,         │
│                              │   480px sq     │        order:-1, on top         │
│                              ╰───────────────╯                                 │
│  ┌─ rail ─┐┌─ context register  (extends right, no inner scrollbar) ─────────▶ │
│  │ dims + ││ SYM · DOC · Region · Channel · Segment · … · Justif · Kids · Dup  │
│  │ params ││ α    ·  ●  ·  APAC  ·  Web   ·  SMB   · … ·  “…”   ·  2 ▸ ·  =β    │
│  │        ││ β    ·  ○  ·  EMEA  ·  App   ·  Ent   · … ·  “…”   · Open ·        │
│  │        ││ + New context…  (phantom row — the keyboard create home)          │
│  └────────┘└──────────────────────────────────────────────────────────────▶── │
└──────────────────────────────────────────────────────────────────────────────┘
                                                        (canvas continues right ▸)
```

New-context affordance here: **drop the top `.canvas-toolbar` button**; the register phantom row + `c` key are the create paths. (Requires resolving the compose-vs-phantom fork — see forks.)

### Direction B — Register defines the node width; ring left-aligned in the header band

The ring stops being centered (centering over a very wide register wastes a lot of horizontal travel to reach it); it left-aligns so ring + first columns are co-visible, and the create affordance sits in the ring's band, right of it — physically near the register's left edge.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ⠿ Design                                                                        │
├──────────────────────────────────────────────────────────────────────────────┤
│ ╭───────────────╮   [ + New context ]   ← affordance in the ring band,          │
│ │    ( ring )    │                          adjacent to register's top-left      │
│ ╰───────────────╯                                                               │
│  ┌─ rail ─┐┌─ context register (extends right) ───────────────────────────▶──   │
│  │        ││ SYM · DOC · Region · Channel · … · Justif · Kids · Dup             │
│  └────────┘└────────────────────────────────────────────────────────────▶───   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Direction C — Keep a width cap + column-group LOD (fallback if unbounded feels wrong)

Keep a soft max node width; past a dimension threshold, collapse the dimension columns into a **single "tuple" summary column** at low zoom / above N dimensions, expanding to per-dimension columns only near 1:1 or on focus. Preserves legibility at 10+ dimensions without an unbounded scroll.

```
Overview / many dims                        Near 1:1 / focused
SYM · DOC · Tuple ······· · Justif · Kids   SYM · DOC · Region · Channel · Segment · …
α   ·  ●  · APAC·Web·SMB · “…”    · 2 ▸     α   ·  ●  ·  APAC  ·  Web   ·  SMB   · …
```

**New-context affordance options (orthogonal to A/B/C):**

- **Opt 1 — Remove the top button; register phantom + `c` are the only paths.** Cleanest, but loses the button's *compose-mode* entry unless the phantom row is upgraded to enter compose (fork 3).
- **Opt 2 — Relocate the button adjacent to the register** (its own header/toolbar strip, or the ring band per Direction B). Keeps compose-mode entry, ends the top-of-node stranding.
- **Opt 3 — Keep `c` + register phantom, and unify semantics** so the phantom-row create *also* enters compose mode (guided binding), collapsing the two grammars into one.

## Open design forks (OWNER decisions — do not resolve unilaterally)

1. **Scope: canvas-only vs broader.** Should "extend right" apply **only to the D3 `?d3rf` canvas** (where infinite space + pan make it natural), or also to the **D2 lane page** (`WorkspaceSurface`) and the **normal single-Design route**? On D2 the Design lane is the rightmost lane but the page is not an infinite plane — a wider register pushes **page-level horizontal scroll** into the shared `.surface` (SITEMAP §2's "page never scrolls" is already relaxed for lanes, but this widens it). *Investigation recommendation:* **canvas-only** — gate the "extend right / no inner scroll" behavior behind the D3 node, and leave D2 / normal route on the current `.register-scroll` inner-scroll (or a later, separate decision). But the owner may want one consistent register everywhere.
2. **Ring-vs-register layout when the register is much wider than the ring** (`base.css:1680` ring is ≤480px; register can be 1500px+). Options: **(a)** ring centered above the full register width (Direction A — lots of the band is whitespace, and the ring is far from the far columns); **(b)** ring left-aligned, register defines width (Direction B); **(c)** register defines node width and the ring "floats"/pins to the viewport-left as you pan. Note the Canvas hit-target sizing constraint (`base.css:1669-1672`) — the ring's shell width still drives dot hit radii, so whatever is chosen must keep the ring's own measured box a clean square.
3. **Fate of the top "New context" button** (`DesignSurface.tsx:649-658`): **remove** (Opt 1), **relocate adjacent to the register** (Opt 2), or **keep + unify compose/phantom semantics** (Opt 3)? This forks together with whether the register phantom row should enter **compose mode** (guided binding) rather than just seeding justification (`ContextRegister.tsx:283-289`).
4. **Width: unbounded vs capped.** Truly unbounded (pan to reach any column, Direction A) or a **soft max node width** past which columns compress / group (Direction C)? Unbounded is simplest and most canvas-native; a cap protects legibility and the overview zoom.
5. **LOD threshold.** If a cap/LOD is chosen (fork 4 → C): at what **dimension count** (e.g. > 6–8 columns) and/or **zoom level** do the per-dimension columns collapse into a tuple-summary column, expanding near 1:1 or on focus? Also: is any **column virtualization** warranted at 10+ dimensions, or is DOM-width fine given the register row count is usually modest?

## Test-first plan (red first)

**Phase 1 — the register stops clipping on the canvas (Direction A/B):**
1. **No inner horizontal scrollbar on the D3 Design node** — `WorkspaceCanvas.test.tsx` (or a `ContextRegister` test under a D3-node wrapper): with N dimensions large enough to exceed 960px, the register renders **all** trailing columns (JUSTIFICATION/CHILDREN/DUPLICATE headers present and laid out past 960px) and the register wrapper does **not** apply `overflow-x: auto` in the canvas context. Red today: `.register-scroll { overflow-x: auto }` (`base.css:930`) clips.
2. **Design node measures wider than 960px when the register demands it** — assert the Design node's rendered width tracks content (no hard `width: 960px` clamp on the Design node) while Foundation/Architecture nodes keep their derived x (`laneLayout.ts` x unchanged). Red today: `.wc-node { width: 960px }` (`base.css:371`).
3. **Growing right does not shift other lanes** — a `laneLayout` / layout assertion: with a wide Design node, Foundation and Architecture x are unchanged (Design is `LANE_ORDER[2]`). Green-by-construction guard (protects the constant-stride invariant `WorkspaceCanvas.tsx:91`).

**Phase 2 — the create affordance is re-homed (fork 3):**
4. **"New context" is adjacent to the register, not stranded above the ring** — assert the create affordance is a sibling/child of `.context-register-shell` (or removed in favor of the phantom row), not inside a top `.canvas-toolbar` above `order:-1` ring. Red today: `DesignSurface.tsx:649-658`.
5. **One create grammar (if Opt 3 chosen)** — the register phantom-row create enters compose mode (guided binding), matching the `c`/button path. Red today: `ContextRegister.tsx:283-289` seeds justification only.

**Phase 3 — interactions:**
6. **Focus-pan reaches a right-edge cell** — Tabbing to a DUPLICATE-column cell that is off-screen right triggers the canvas focus-pan (`WorkspaceCanvas.tsx:531-554`) so the cell comes on-screen. Red until the register is allowed to extend past the pane.
7. **(If LOD chosen, fork 4/5)** — above the dimension threshold / below a zoom level, per-dimension columns collapse to a tuple-summary column and expand near 1:1. Red today (no LOD).
8. **Coverage toggle + child canvas unaffected** — switching to the coverage matrix (`v`) and drilling into a child canvas still render correctly with the widened register (no layout leak from the canvas-only rule).

Standing gate: `npm run verify:fast` green (`npx tsc --noEmit`, `npx eslint . --quiet`, `npx stylelint`, vitest) + the D3 e2e sweep behind `?d3rf`.

## Acceptance criteria

- [ ] **No clipped columns on the D3 canvas** — with many dimensions, the register shows SYMBOL · DOCUMENTED · every dimension · JUSTIFICATION · CHILDREN · DUPLICATE with **no inner horizontal scrollbar**; far columns are reached by **panning** (test 1).
- [ ] **Content-driven Design node width** — the Design node measures to the register's natural width; the fixed `width: 960px` cap no longer clips it (test 2), and **no other lane's x shifts** (test 3, Design is rightmost).
- [ ] **Create affordance re-homed** — "New context" is adjacent to the register (or folded into its phantom row), not stranded at the top above the ring; the compose-vs-phantom semantics are reconciled per the owner's fork-3 choice (tests 4–5).
- [ ] **Pan reaches far cells** — focusing an off-screen-right register cell pans it on-screen (test 6).
- [ ] **Scope honored** — the behavior is gated per the owner's fork-1 decision (canvas-only recommended); D2 / normal route are unaffected unless the owner opts them in (test 8).
- [ ] **(Optional, fork 4/5)** — LOD/column-grouping kicks in at the chosen threshold (test 7).
- [ ] **No regression** — coverage toggle, child-canvas recursion, and the rail→register Tab bridge (`DesignSurface.tsx:435-457`) all still work; `verify:fast` + D3 e2e green.

## References

- **Code (verified file:line):**
  - `src/components/ContextRegister.tsx:123-247` (column model — per-dimension spread `:159-179`; trailing Justification/Children/Duplicate `:180-246`), `:279-291` (phantom "New context" row create path).
  - `src/components/EditableGrid.tsx:1051-1104` (`.register-scroll` > `.editable-grid` render).
  - `src/components/DesignSurface.tsx:646-727` (canvas-toolbar + design-surface-row structure), `:649-658` (top "New context" button → `enterCompose`), `:216-251` (`enterCompose` — compose mode), `:311-333` (`c` key), `:435-457` (rail→register phantom Tab bridge).
  - `src/components/WorkspaceCanvas.tsx:91` (`LANE_CONFIG.laneWidth = 960` constant stride), `:185-201` (`withDerivedPositions` — height-keyed), `:208-233` (Design `LaneNode`), `:392-465` (desired nodes), `:531-554` (focus-pan).
  - `src/domain/laneLayout.ts:26` (`LANE_ORDER`, Design last), `:55-63` (`laneX` pure fn of tier), `:76-91` (`computeLaneLayout` — y-stack by height).
  - `src/components/WorkspaceSurface.tsx:79-91` (D2 Design lane), scope-fork context.
  - **CSS (`src/styles/base.css`):** `:370-375` (`.wc-node { width: 960px }`), `:927-934` (`.register-scroll { overflow-x: auto }`), `:936-962` (`.editable-grid` width:100% + nowrap `th`), `:1010-1018` (frozen sticky symbol column), `:1614-1625` (`.design-surface-row` ring-on-top column), `:1631-1647` (editing zone `order:2`), `:1673-1681` (ring `order:-1`, `min(480px,60vh,100%)` + hit-target note `:1669-1672`), `:1683-1700` (register shell), `:1731-1737` (`.canvas-toolbar`), `:268-274` (`.workspace { min-width: min-content }`, D2 scroll).
- **Docs:** `docs/STYLE_GUIDE.md` §1 principle 4 (position is derived — the canvas invariant this must not break), §6 (Tables / Numbers grammar — frozen symbol column, column separation), §3 (only circles are data geometry — the ring) · `docs/SITEMAP.md` §2 (shell anatomy / "page never scrolls", relaxed for lanes in 089-D2), §4 (`c` = New context, `v` = view toggle) · `docs/SPEC.md` §4.2–4.5 (canvas / register / compose).
- **Related issues:** **089** (`docs/issues/089-unified-canvas-workspace.md` — D3 pan/zoom canvas, spike GO 2026-07-18, P0–P3.4; the "stack register over ring" idea is explicitly a D3 concern per D2 notes line 48). **082/085** (Design-route editing-zone / phantom-row grammar this builds on). **084** (the sibling Architecture-lane register-UX writeup — same yardstick, same forks-as-owner-questions format).
