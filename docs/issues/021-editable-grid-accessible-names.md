# 021: Accessible names & grid semantics for EditableGrid (and inplace inputs)

- **Status**: OPEN
- **Milestone**: M6 (Polish — keyboard/a11y flows)
- **Blocked by**: 004 (SHIPPED)

## Slice

As a keyboard/screen-reader user I can tell what every field, cell, and control **is** — each editable cell announces its column and row, each in-place editor has a real accessible name, and the register reads as a proper data grid — so the app is operable without sighted, mouse-driven context. STYLE_GUIDE §10 makes this a per-issue acceptance criterion, not a polish pass.

## Bug report (from user testing)

> "Labels are missing for almost all the elements on the page."

Confirmed empirically by driving the running app with Playwright and computing each control's ARIA accessible name (strict sources only — `aria-label` / `aria-labelledby` / associated `<label>` / `title`; **not** placeholder or inner text, which are weak or absent for form controls):

| Finding | Evidence |
| --- | --- |
| In-cell editing `<input>` (text/mono/symbol) has **no accessible name** | focused editor reports `aria-label: null`, no `<label>`, no `placeholder` — a screen reader announces "edit text, blank" |
| In-cell editing `<textarea>` (justification) has **no accessible name** | same — `aria-label: null` |
| Combobox trigger `<button>` (dimension binding) has **no accessible name** | empty ones contain only the visual "—"; SR hears "dash, button" with no column/dimension context |
| Register `<table class="editable-grid">` is **not a grid** and has **no column-header association** | `role: null`; **0 of 7 `<th>` carry `scope`** — reading any data cell never announces which dimension column it is in |
| Empty cells render a literal em-dash as content | 4 `.grid-cell__placeholder` "—" spans on a 2-row register; SR reads "dash" as the cell value |
| `inplace-input` primitive (projects phantom, context phantom) is named **only by placeholder** | placeholder is not a robust accessible name (disappears on input; inconsistently exposed) |

Net effect: the cells carry `role="gridcell"` + `tabIndex=0` + arrow-key roving (a half-built grid pattern) but none of the semantics that make that pattern legible — no `role="grid"`/`role="row"`, no header association, no per-control names. So "almost every element" is unlabeled to assistive tech.

## Scope

- Give every **in-place editor** (text/mono `<input>`, multiline `<textarea>`, combobox trigger `<button>`, phantom `<input>`) a real accessible name composed from **column header + row identity** (e.g. "Symbol", "Value binding for α", "Justification for α", "New context").
- Make the register a **coherent data grid** for assistive tech: either complete the ARIA grid pattern (roles + `aria-colindex`) **or** rely on native table semantics with `<th scope="col">` and cell/header association — pick one and make it consistent (see Implementation notes for the recommendation). No half-built pattern.
- Stop empty cells from announcing "dash": the em-dash is decorative (`aria-hidden`), the cell's name comes from its column + an "empty" state.
- Applies to **every** `EditableGrid` consumer (register, Foundation, Architecture, parameters, dimensions) since the primitive is shared — one fix, all tiers.

Out of scope: color-contrast audit (STYLE_GUIDE §10 already tracks it via the M2 CI contrast test), canvas/SVG a11y (its own concern), and the keyboard *navigation* grammar (Tab/Enter editing flow) — that is **issue 022**; this issue is naming/semantics only.

## Design brief

- **Naming convention**: `{column header} for {row label}` for data cells (e.g. "Justification for α"), bare `{column header}` where a row label doesn't apply (phantom/new-row inputs use their existing placeholder text as the name). Combobox: `{column header}: {selected value or "unset"}`. Names are notation-free plain language (Inter voice), symbols spoken as their letter where possible.
- **Grid semantics**: the register reads top-to-bottom as "grid, N columns, M rows; row 1: Symbol α, Value Comfort, …". Column headers are programmatically the header of each cell.
- **Empty state**: an unbound cell announces e.g. "Value for α, empty" — never "dash". The visual "—" stays (STYLE_GUIDE placeholder treatment) but is `aria-hidden`.
- **No visual change**: this is a semantics/naming pass — zero pixels move. Focus ring, tokens, layout unchanged (STYLE_GUIDE §5/§6). Verified by re-running the existing component/e2e snapshots unchanged.
- **Consistency with shell**: focus order already follows the shell bands (STYLE_GUIDE §10, SITEMAP §2); this issue only adds names within the surface, it does not reorder anything.

**References**: STYLE_GUIDE §10 (accessibility baseline — programmatic labels, keyboard operability as acceptance criterion) · SITEMAP §2 (focus-order bands) · issue 004 (EditableGrid core, `role="gridcell"` cells) · issue 005 (multiline justification cell) · ADR-0004 (EditableGrid owns every cell)

> **UI build convention (018–020):** compose the shared `src/components/ui/` primitives and reuse `EditableGrid`; style only via design tokens. No hand-rolled `<button>`/`<input>` or hardcoded colors (lint-enforced — ADR-0007 · STYLE_GUIDE §11).

## Test-first plan

1. Component (`EditableGrid.test.tsx`): every editing control exposes a non-empty accessible name — assert via Testing Library `getByRole('textbox', { name: /justification for/i })`, `getByRole('button', { name: /value: /i })` (fails today: names are absent).
2. Component: an **empty** combobox/text cell has an accessible name ending in/indicating "empty" and does **not** expose the literal "—" as its name (`aria-hidden` on the placeholder span).
3. Component: `<table>` exposes grid/table semantics with column headers associated to cells — assert `getAllByRole('columnheader')` count = column count and each has `scope="col"` (or, if ARIA grid chosen, `role="grid"` + `role="row"` + `role="gridcell"` with `aria-colindex`).
4. Component: the phantom "new row" input has an accessible name (not placeholder-only).
5. e2e (`a11y-names.spec.ts`, new): drive the real register, snapshot the ARIA tree of the grid region, assert no interactive descendant has an empty accessible name (the strict-name audit that surfaced this bug, kept as a regression guard).
6. Regression: existing register/foundation/architecture e2e specs still pass unchanged (no behavioral/visual regression).

## Acceptance criteria

- [ ] No interactive element inside any `EditableGrid` (or the shared inplace/phantom inputs) has an empty ARIA accessible name — verified by the e2e name-audit guard.
- [ ] Reading any data cell announces its column (dimension/field) and, where applicable, its row (context symbol).
- [ ] Empty cells announce an "empty" state, never "dash".
- [ ] The register presents consistent grid **or** table semantics (no partial/contradictory roles).
- [ ] `npm run verify` green (typecheck, eslint, stylelint, vitest, playwright); zero visual diff on existing snapshots.

## Implementation notes

- **Where names come from**: `EditableGrid` is generic and must not hardcode "for α". Extend the column/grid API so callers pass a row label source — e.g. an optional `getRowLabel?: (row) => string` on `EditableGridProps` (register passes context symbol; Foundation passes rank/name; etc.) and the grid composes `${column.header}${rowLabel ? ` for ${rowLabel}` : ''}`. Column `header` string already exists on `GridColumn`.
- **Editors** (`TextOrMonoCell`, `MultilineCell`, `ComboboxCell` trigger, `PhantomCell`): add `aria-label={computedName}` to the `<input>`/`<textarea>`/`<button>`/phantom `<input>`. Combobox trigger name includes the current value or "unset".
- **Grid semantics — recommendation**: prefer **native table + scoped headers** over completing the ARIA grid, as the lower-risk path — add `scope="col"` to each `<th>`, keep the native `<table>`/`<tr>`/`<td>`, and **drop** the ad-hoc `role="gridcell"`/`tabIndex` grid roles in favor of the roving-tabindex living on the editors themselves. If the team wants the full ARIA grid (justified by the existing arrow-key roving), do it completely: `role="grid"` on the table, `role="row"` on every `<tr>`, `role="gridcell"`/`role="columnheader"`, and `aria-colindex`/`aria-rowindex`. Do **not** ship the current in-between state. Coordinate this decision with issue 022 (which owns the keyboard grammar those roles imply).
- **Empty placeholder**: add `aria-hidden="true"` to `.grid-cell__placeholder`; the cell's name (from the editor's `aria-label` or a `<td>`-level name) conveys emptiness.
- **Shared inputs**: the `inplace-input` used by projects/context phantoms is the `PhantomInput`/`InlineEdit` primitive (`src/components/ui/`) — add an `aria-label` prop threaded from callers so the projects-list and register phantoms are named beyond placeholder.
- **Lint**: adding `aria-label` to the sanctioned `EditableGrid`-owned raw `<input>`/`<button>` stays within the ADR-0007 exemption (EditableGrid owns its cells); no new raw controls introduced.
- Pairs with **022** (keyboard editing grammar) — same file (`EditableGrid.tsx`), complementary concerns (this = naming/semantics, 022 = navigation). Land 021 first (semantics) so 022's new focus targets are already named, or land together in one branch to avoid two passes over the same file.
