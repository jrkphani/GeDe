# GeDe — Generative Design Process App

## SPEC v0.2 · 2026-07-04

Source of truth: `GeDe Tavalo.numbers` (design method example). Prototype references: four Claude Desktop mockups (circle canvas, justification composer, architecture sketch, UX flow wireframes).

v0.2: canvases generalized from fixed 3 dimensions to **n dimensions × m parameters each**; the Value/Stake/Process triple is only the worked example. Coverage requirement: every parameter combination must be able to hold at least one context.

---

## 1. Vision

GeDe captures a structured system-design method in three tiers:

- **1st Tier — Foundation**: the purpose of the system and its ranked value propositions.
- **2nd Tier — UDS Architecture**: architecture tables (in the example: Value, Stakeholders, Process) that enumerate and describe the design vocabulary.
- **3rd Tier — System Design**: the critical piece. A canvas carries **n dimensions** (n ≥ 2; the example has 3: Value, Stake, Process), each holding an ordered set of **parameters** (m per dimension, independent per dimension). Designers place **contexts** (α, β, ε, λ, μ, θ, π…) on the canvas; each context binds **exactly one parameter per dimension** and carries a **justification** — a plain-language statement of why that combination matters (e.g. *"Superstars are the predominant engagers of the table"*). Contexts recurse: opening a context spawns a child canvas whose dimensions are the parent's n bound parameters, refined by their sub-parameters, with sub-contexts (α1…αn) inside. This recursion is unlimited in depth.

The app is the tool that lets a designer perform, record, and audit this process — including seeing which parameter combinations are **documented vs unexplored**. Every combination in the cross-product of the canvas's dimensions must be able to hold **at least one context**.

### Decisions (locked 2026-07-04)

| Decision | Choice |
| --- | --- |
| Canvas geometry | **Circle** with **one arc per dimension** (n arcs), per prototypes. Node position is decorative; meaning lives in bindings. |
| Dimensionality | **n dimensions per canvas** (n ≥ 2, no hard upper bound; UI optimized for 2–8), m parameters per dimension. |
| Recursion depth | **Unlimited** — any context opens as a child canvas; breadcrumb navigation. |
| Users & sync | **Single-user first, sync-ready** — local persistence now; schema and invariants compatible with later Postgres + workspace RLS + realtime row-delta sync. |
| Scope | **All three tiers** — 3rd Tier canvas ships first; Tiers 1–2 are structured forms whose outputs feed the canvas dimensions/parameters. |

---

## 2. Domain model

### Glossary

| Term | Meaning |
| --- | --- |
| **Project** | One design effort (e.g. "GeDe Tavalo" table system). Contains all three tiers. |
| **Purpose** | 1st Tier: single rich-text statement of what the system is for. |
| **Value Proposition** | 1st Tier: ranked entry (rank 1°, 2°, …) with name + description (e.g. "Seating-status comfort", "Mobility fluidity"). |
| **Architecture Entry** | 2nd Tier: a row in an architecture table (example tables: Value / Stakeholders / Process): name + description, hierarchically nested (e.g. Users → One° of Circle → Superstar). |
| **Canvas** | A design surface with its own set of dimensions and contexts. The project has one root canvas; every context can own one child canvas. |
| **Dimension** | One of a canvas's n axes (name, color, sort order). The root canvas of the example has 3 (Value, Stake, Process); any count ≥ 2 is valid and dimensions can be added or removed per canvas. |
| **Parameter** | An ordered point on a dimension (e.g. Stake: Buyers, Maintainer, Users). Parameters form a tree: a parameter may have sub-parameters (`parent_param_id`) that appear when the parent becomes a dimension of a child canvas (Users → Zero°/Inner°/Second°/Third°/Outer° Circle). |
| **Context** | A design decision node (α, β, …). Lives in a tree (`parent_id`): root contexts sit on the root canvas; children of α (α1, α2…) sit on α's child canvas. Has symbol, optional name, justification. |
| **Binding** | The pair (context × dimension → parameter): exactly one per dimension per context. The set of a context's n bindings is its identity on the canvas. |
| **Statement / Justification** | Prose attached to a context explaining the tuple. First-class, searchable. |
| **Coverage tuple** | Any element of the cross-product of all n dimensions' parameter sets on a given canvas (∏ mᵢ tuples). Documented when at least one complete context binds it; otherwise unexplored. |

### Core invariants

1. **One parameter per dimension per context.** A binding set is complete iff it covers **all n dimensions** of its canvas. Incomplete contexts are allowed as drafts but visually flagged.
2. **At least one context per combination.** Every coverage tuple must be bindable: the app never blocks creating a context on any combination. Multiple contexts on the same tuple are permitted (distinguished by symbol and justification); a duplicate tuple raises a non-blocking warning showing the existing context(s). Coverage counts a tuple documented when ≥ 1 complete, justified context binds it. Coverage is informational only — it is never a gate on saving, exporting, or any notion of a canvas being "done".
3. **Recursion rule.** A context's child canvas has exactly the parent's n bound parameters as its dimensions (one child dimension per parent binding); the selectable parameters on each are that parameter's sub-parameters. Creating a child canvas prompts creation of sub-parameters if none exist yet.
4. **Dimension mutability.** Dimensions can be added to or removed from a canvas at any time. Adding one demotes all existing complete contexts on that canvas to drafts (missing the new binding) until re-bound; removing one deletes its bindings (undoable). Both operations warn with impact counts.
5. **Layout is derived, never stored.** Canvas geometry (arc positions, node placement, spoke routing) is a pure function of the context tree + bindings. No x/y coordinates in the database, none on any future sync wire.
6. **Two projections, one tree.** The circle canvas and the context register table render the same store; edits in either are edits to the tree.
7. **Tier linkage.** 3rd Tier root dimensions and parameters are created *from* 2nd Tier architecture entries (each parameter keeps a reference to its source entry); editing the source propagates the name, deleting requires resolution.

---

## 3. Data model (sync-ready)

All ids UUIDv7. All rows carry `created_at`, `updated_at` (LWW timestamp for future sync), `deleted_at` (soft delete). Local persistence now; the same schema maps 1:1 onto Postgres with workspace-scoped RLS later.

```text
projects        id · name · description
tier1_purpose   id · project_id · body
tier1_props     id · project_id · rank · name · description · sort
tier2_tables    id · project_id · name · sort            (example: Value, Stakeholders, Process)
tier2_entries   id · table_id → tier2_tables · parent_id → tier2_entries
                · name · description · sort
canvases        (implicit — root canvas = project, child canvas = context; no table needed)
dimensions      id · project_id · context_id (null = root canvas) · name · color · sort
                · source_param_id → parameters (set for child canvases)
parameters      id · dimension_id · parent_param_id → parameters · name · sort
                · source_entry_id → tier2_entries (nullable)
contexts        id · project_id · parent_id → contexts (null = root) · symbol · name
                · justification · sort
bindings        id · context_id · dimension_id · parameter_id
                · UNIQUE(context_id, dimension_id)
                · tuple_hash (ordered parameter ids) — indexed per canvas for duplicate
                  warnings and coverage lookup; NOT unique (invariant 2 allows multiples)
```

Notes:

- The schema is already n-ary: a canvas's dimension count is simply the number of `dimensions` rows scoped to it. No column encodes "3".
- `dimensions.context_id` realizes the recursion: α's child canvas rows are `dimensions WHERE context_id = α`, seeded one-per-binding from α's bindings.
- Greek symbols auto-assigned from a cycle (α β γ δ ε λ μ θ π …) with manual override; children get `parent-symbol + index` (α1, α2).
- Future sync: row deltas only, LWW per record, no positions on the wire — all satisfied by invariant 5 and the timestamp columns.

---

## 4. Application spec

### 4.1 Navigation shell

- **Projects list** → open project → tier tabs: `Foundation · Architecture · Design`.
- All three tiers present as **table-based views mirroring the Numbers document**. Tiers 1–2 are tables only; the Design tab (Tier 3) shows the **context register table accompanied by the circle canvas** — side by side on wide screens, toggle/stacked on narrow ones. Neither is secondary: the table is the record, the canvas is its spatial companion (invariant 6 — same tree, two projections).
- Drilling into a context pushes a breadcrumb (`Root ▸ α ▸ α2 ▸ …`) and scopes both table and canvas to that child canvas. Breadcrumbs are the primary depth navigation; browser back works.

### 4.2 Circle canvas (the critical piece)

- SVG, responsive. **One arc per dimension**: the circle is divided into n equal arc segments (with gaps), one per dimension in sort order, each in its dimension color (defaults drawn from a categorical palette; editable). Parameter dots ordered along each arc; labels outside. The 3-arc prototypes are the n = 3 case.
- Degenerate/high-n handling: n = 2 renders as two half-circle arcs; for large n (> 8) arcs compress and labels collapse to hover/legend — functional but the UI is optimized for 2–8.
- Canvas header exposes **dimension management**: add/rename/recolor/reorder/remove dimensions (invariant 4 warnings on add/remove).
- Context nodes rendered inside the circle (auto-placed by a deterministic layout function — e.g. centroid of bound-parameter positions with hash-seeded jitter for collisions, so identical data always renders identically).
- Selecting a context draws its n spokes (one per dimension, colored by dimension) and shows its justification in the composer bar (per prototype 2: per-dimension legend + justification pill + tuple `{Comfort} {Users} {Engagement}` + statement). The tuple readout lists all n bound parameters in dimension order.
- Contexts with children show a badge (count); double-click / enter drills in.
- Empty-state: canvas with dimmed arcs and a "bind your first context" prompt.
- Interactions: click parameter dot while composing = bind; click bound dot = unbind; keyboard-completable (arrow between dimensions, type-ahead parameter picker).

### 4.3 Context register (table projection)

- Same tree as the canvas: columns `Symbol · <one column per dimension, in sort order> · Justification · Children`. Columns are dynamic — adding a dimension adds a column.
- Inline editing; row selection syncs with canvas selection. Indent/outline view toggles the full tree across depths.
- Export: CSV/Markdown of the register per canvas and flattened across depths.

### 4.4 Composer

- Invoked by "New context", by clicking an unexplored cell in the coverage matrix (pre-filled), or by duplicating an existing context.
- Fields: symbol (auto), one parameter picker per dimension (n pickers, rendered in dimension order), justification (required to mark "documented"), optional name.
- Duplicate-tuple warning inline (invariant 2): shows existing contexts on the same tuple, never blocks.
- Also handles **refinement**: from a context, "Add sub-context" jumps into its child canvas with the composer open.

### 4.5 Coverage matrix ("documented vs unexplored tuples")

- Per canvas, over the full n-dimensional tuple space (∏ mᵢ combinations). Rendered as a 2-D grid: user picks which two dimensions form rows × columns; each remaining dimension becomes a filter/pager control (defaults: the two largest dimensions on the grid, others paged). For n = 2 this is a plain grid; n = 3 matches the prototype's grid + one pager.
- Documented tuples show their context symbol(s); unexplored are hollow.
- Click a hollow cell → composer pre-filled with that tuple (prototype 4's "gap → pre-filled composer"). Every tuple is reachable this way (invariant 2).
- Header shows coverage stat: `12 / 45 tuples documented` (denominator = ∏ mᵢ; recomputed live as dimensions/parameters change).

### 4.6 Tiers 1–2 (table-based, per the Numbers document)

Tiers 1–2 keep the tabular presentation of the source document — editable tables, not bespoke form UIs.

- **Foundation**: purpose text block + ranked value-propositions table (columns: rank 1°, 2°… · name · description; drag to re-rank).
- **Architecture**: nested-row tables — one per intended dimension (the example ships with Value / Stakeholders / Process; tables can be added/renamed), each row name + description, arbitrary nesting.
- **Promote to Design**: from the Architecture tab, select entries → "use as dimension/parameters" seeds or extends the root canvas (each table maps to one dimension). Link is kept (invariant 7); a badge on parameters shows their tier-2 source.

### 4.7 Cross-cutting

- Full-text search across justifications, parameter names, tier-2 descriptions; results deep-link to canvas selection.
- Undo/redo across all edits (store-level command log), including dimension add/remove (invariant 4).
- Autosave; explicit project export/import as a single JSON file (also the backup format).
- Light/dark theme (prototypes are dark-first).

---

## 5. Architecture & stack

Per prototype 3, adapted to "single-user first, sync-ready":

```text
UI          React 19 + TypeScript · SVG canvas (no canvas lib needed at this scale)
State       Context tree store (Zustand) — single source of truth, optimistic writes,
            command log for undo/redo
Layout      pure fn(tree) → geometry · memoized · never persisted · n-arc division
Persistence adapter interface:
              v1: local — SQLite (Tauri) if desktop app, else IndexedDB (Dexie) as PWA
              v2: Supabase/Postgres + auth + workspace RLS + realtime row deltas (LWW)
Validation  Zod schemas shared between store and persistence
Testing     Vitest (store/layout invariants) + Playwright (canvas interactions)
```

Sync-readiness checklist enforced from day one: UUIDv7 ids, LWW timestamps, soft deletes, row-granular mutations through a single mutation layer, no derived data persisted.

**Resolved (see TECH_STACK.md):** installable PWA with PGlite (Postgres-in-WASM) for v1 persistence — one Postgres schema and migration history from v1 through v2. TECH_STACK.md is the authoritative document for all library, database, and hosting choices; where it and this section differ, TECH_STACK.md wins.

---

## 6. Milestones

| # | Milestone | Contents | Done when |
| --- | --- | --- | --- |
| M1 | Core model + register | Store, schema, invariants 1–4, context register CRUD, persistence, undo | All invariant unit tests pass, including n-dim cases (n = 2, 3, 5) and dimension add/remove demotion; a project survives reload |
| M2 | Circle canvas | n-arc layout, parameters, context nodes, spokes, composer, dimension management, selection sync with register | Recreate prototype image 1 (α with Comfort/Users/Engagement) by direct manipulation; then add a 4th dimension and re-complete α; deterministic layout snapshot tests at n = 2, 3, 4 |
| M3 | Recursion | Child canvases, sub-parameters, breadcrumbs, symbol lineage | Reproduce the Numbers drill-down: α → canvas with Seating comfort/Users/Modality of engagement and sub-contexts α1–α4 |
| M4 | Coverage matrix | n-dim tuple grid with axis pickers + filters, gap → pre-filled composer, coverage stats | Every tuple reachable: clicking any hollow cell opens composer with all n parameters pre-selected, at n = 3 and n = 4 |
| M5 | Tiers 1–2 | Foundation + Architecture tables (Numbers-style), promote-to-design linkage | Full GeDe Tavalo example enterable end-to-end from the Numbers doc |
| M6 | Polish | Search, export/import JSON + CSV, themes, keyboard flows | — |
| v2 | Collaboration | Auth, workspaces, realtime row-delta sync, presence | Out of scope for v1; schema must not require migration beyond additive columns |

Each milestone = one implementation session (≤ 5 files per phase, verification between phases per workflow rules).

## 7. Verification targets

- `npx tsc --noEmit` and `npx eslint . --quiet` clean at every phase end.
- Invariant tests: binding completeness across n dimensions, duplicate-tuple warning (not block), dimension add/remove demotion, recursion seeding, layout purity (same tree → identical SVG snapshot) at multiple n.
- Coverage property test: for random canvases (2 ≤ n ≤ 5, 1 ≤ mᵢ ≤ 6), every tuple in ∏ mᵢ is reachable via the matrix and accepts a context.
- Visual: side-by-side screenshot vs prototype images 1–2 at M2; vs Numbers drill-down capture at M3.

## 8. Non-goals (v1)

- Multi-user editing, comments, presence (v2).
- Triangle/ternary projection (geometry decision = circle; the pure-layout design keeps a second projection cheap if revisited — note a ternary layout only exists for n = 3).
- Import from `.numbers` files.
- Mobile-optimized editing (read-only responsive is enough).
