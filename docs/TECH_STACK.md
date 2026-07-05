# GeDe — Tech Stack

## v1.0 · 2026-07-04 · companion to SPEC.md v0.2

Selection criteria, in order: (1) open source with permissive licenses, (2) lowest possible AWS running cost, (3) well-maintained with large communities, (4) satisfies the spec's invariants — especially *layout derived never stored*, *migrations for all schema changes*, *sync-ready without rewrite*, and *Numbers-style in-place editing*.

---

## 1. Summary

| Layer | Choice | License | Why in one line |
| --- | --- | --- | --- |
| Database engine | **PostgreSQL 17** — as **PGlite** (WASM) in-browser for v1, real Postgres for v2 | PostgreSQL License / Apache-2.0 | One engine, one SQL dialect, one migration history from day one; v1 costs $0 |
| ORM / migrations | **Drizzle ORM + drizzle-kit** | Apache-2.0 | TypeScript schema-as-code; same `pg` schema drives PGlite and server Postgres |
| Framework | **React 19 + TypeScript 5 + Vite** | MIT | Per SPEC §5; Vite for dev speed and static builds |
| State | **Zustand** (+ command log for undo) | MIT | Per SPEC §5; minimal, store-level middleware for undo/redo |
| Validation | **Zod** | MIT | Shared schemas between store, persistence, import/export |
| Tables (all tiers) | **TanStack Table v8** (headless) + custom editable cells + **dnd-kit** for re-rank | MIT | Only mainstream grid that gives nested rows + full markup control for the Numbers aesthetic, free |
| Canvas | **Hand-rolled SVG in React** + **d3-shape** for arc geometry | MIT / ISC | The canvas is bespoke; a charting lib would fight the deterministic pure-layout invariant |
| UI chrome | **Radix primitives via shadcn/ui** + **Tailwind CSS v4** | MIT | Accessible menus/popovers/dialogs without owning a design system |
| App shell | **Installable PWA**, static hosting | — | Resolves SPEC §5 open question; cheapest possible AWS footprint |
| v1 hosting | **S3 + CloudFront** | — | ~$0–1/month |
| v2 database hosting | **Postgres on Lightsail** ($5–10/mo) → RDS only when ops pain justifies it | — | Cheapest always-on open-source Postgres on AWS |
| v2 sync | **ElectricSQL** (Postgres → client sync) or self-hosted **Supabase** | Apache-2.0 | Both open source, both Postgres-native; decide at v2 kickoff |
| Testing | **Vitest + Testing Library + Playwright** | MIT | Per SPEC §7 |

---

## 2. Database: PostgreSQL everywhere (PGlite now, Postgres later)

### The decision

**PostgreSQL 17** is the single database engine for the project's whole life:

- **v1 (single-user, local-first):** [PGlite](https://pglite.dev) — full Postgres compiled to WASM (~3 MB gzipped), running inside the PWA, persisted to the browser's OPFS/IndexedDB. No server, no AWS bill, works offline.
- **v2 (sync/collaboration):** the same schema and migrations move to a real Postgres server. RLS policies, `UNIQUE` constraints, and triggers written in v1 carry over verbatim.

### Why this beats the alternatives

| Option | Verdict |
| --- | --- |
| SQLite (WASM or Tauri) for v1 | Rejected: forces a dual-dialect schema (SQLite now, Postgres at v2), two migration histories, and re-testing every constraint at the v2 boundary. PGlite removes the entire migration cliff. |
| DynamoDB | Rejected: not open source, and the schema is relational to its core (FK trees, multi-column UNIQUE, cross-product coverage queries). |
| MySQL/MariaDB | Viable but no RLS as mature as Postgres's, and the v2 realtime ecosystem (Electric, Supabase) is Postgres-native. |
| Aurora Serverless v2 | Postgres-compatible but proprietary and cost-unpredictable (ACU-hours + I/O). Revisit only at real multi-tenant scale. |

### Cost on AWS (v2, when a server exists at all)

| Deployment | Approx. monthly | Notes |
| --- | --- | --- |
| **Lightsail 1 GB instance running Postgres 17** | **$5** | Bundled bandwidth; fine for a small workspace product. Snapshot backups ~$0.05/GB. |
| Lightsail 2 GB | $10 | Headroom for Electric/Supabase services alongside |
| EC2 t4g.micro (Graviton) + EBS 20 GB | ~$8 | More control, no bundled bandwidth |
| RDS db.t4g.micro Postgres | ~$13–15 + storage | Managed backups/patching; move here when ops time costs more than the delta |

v1 has **zero database cost** — the database ships inside the app bundle. Static hosting (S3 + CloudFront) for a ~5 MB app is under $1/month at hobby traffic.

### Rules that apply regardless of deployment

- All schema changes go through **drizzle-kit migrations** (global rule: no direct schema edits) — enforced from the first table, even in PGlite.
- Schema uses UUIDv7 keys, `created_at`/`updated_at`/`deleted_at` on every row (SPEC §3 sync-readiness) so the v2 server can adopt LWW row-delta sync without column changes.

---

## 3. Tables: TanStack Table + custom in-place cells

The requirement is **Numbers-style editing**: rows edited in place, no input forms; nested rows (tier-2 hierarchy, context tree); dynamic columns (one per dimension); drag to re-rank; and a visual style matching the source document's clean tables.

### The decision

**TanStack Table v8** (headless, MIT, actively maintained) as the table engine for *all* tables — tier 1 value propositions, tier 2 architecture tables, and the tier 3 context register. It computes rows/columns/expansion state; we own every `<td>`, which is exactly what the Numbers aesthetic and in-place editing demand.

On top of it, a small shared **`EditableGrid`** internal component implements the spreadsheet behaviors once:

- **Click-to-edit cells**: each cell renders as text; click (or Enter) swaps in an borderless input in place — no modal, no side panel. Blur/Enter commits through the store's mutation layer; Esc reverts.
- **Keyboard grammar**: Tab/Shift-Tab across cells, Enter commits + moves down, arrow keys navigate — the Numbers muscle memory.
- **Nested rows**: TanStack's `getExpandedRowModel` + indent rendering for tier-2 nesting and the context register outline view.
- **Dynamic columns**: register columns are generated from the canvas's dimensions at render time (SPEC §4.3).
- **Special cells**: parameter cells in the register render as type-ahead **combobox cells** (Radix Popover + cmdk) constrained to the dimension's parameters — still in-place, still no form.
- **Re-ranking**: **dnd-kit** (MIT, well-maintained) row-drag for tier-1 ranks and sort orders.

The composer (SPEC §4.4) remains for canvas-initiated creation (gap → pre-filled), but table-side creation is just "new empty row, start typing" — consistent with the Numbers feel.

### Why not the alternatives

| Option | Verdict |
| --- | --- |
| AG Grid Community | Excellent inline editing, but **tree data is Enterprise-only** (paid), and overriding its theme to look like a Numbers document means fighting the grid. |
| Glide Data Grid | Canvas-rendered and fast, but custom cell editors, nested rows, and accessibility are all harder; our tables are hundreds of rows, not millions — DOM is fine. |
| Handsontable | **Not open source for commercial use** (non-commercial license). Excluded by criterion 1. |
| Plain `<table>` from scratch | Underestimates sorting/expansion/column-state plumbing; TanStack is headless enough that we keep 100% of the markup control anyway. |

---

## 4. Canvas: hand-rolled SVG + d3-shape

The n-arc circle canvas (SPEC §4.2) is a bespoke visualization with a hard invariant: **layout = pure fn(tree), deterministic, never stored**. No charting library models "n arcs + parameter dots + centroid-placed context nodes + spokes", so a library would be scaffolding to fight, not leverage.

- **React + SVG** components: `<Canvas>`, `<DimensionArc>`, `<ParameterDot>`, `<ContextNode>`, `<Spoke>`.
- **d3-shape** (`arc()`) for arc path math only — ISC license, tiny, the best-maintained geometry code in the ecosystem. No d3 DOM manipulation; React owns the DOM.
- Layout module is a pure TypeScript function `layout(canvasTree) → geometry`, memoized, unit-snapshot-tested at n = 2/3/4 (SPEC §7).
- **Collision resolution**: `d3-force` run *synchronously* inside the layout function — nodes seeded at their binding centroids, a fixed number of collision-only ticks, no randomness. Same input → same output, so the determinism invariant holds while the collision solving is d3's well-tested code, not ours. There is no free-running physics simulation.
- The layout computes in a fixed abstract coordinate space (1000×1000); rendering scales it via the SVG `viewBox`. Responsive behavior is therefore a *labeling and chrome* problem, not a geometry problem — rules live in STYLE_GUIDE.md § Canvas responsiveness.
- Transitions (selection spokes, drill-down zoom) via CSS transitions first; add **motion** (framer-motion successor, MIT) only if choreography demands it — it's an optional dependency, not a foundation.
- Pan/zoom for large canvases: `d3-zoom`-free — a small pointer-events handler on the SVG viewBox is sufficient and keeps the dependency surface minimal.

---

## 5. Application shell & shared infrastructure

- **PWA, not Tauri** (resolves SPEC §5's open question): AWS-hostable as static files, installable on desktop, zero install friction for future collaborators, and v2 sync is web-native. Tauri remains possible later since the entire app is a web build.
- **Vite** build; **vite-plugin-pwa** for the service worker/manifest.
- **Zustand** store with a command-log middleware (undo/redo across all mutations, including dimension add/remove per SPEC invariant 4). All writes flow through one mutation layer that emits row-granular changes — the future sync seam.
- **Zod** schemas at the store boundary and for the JSON export/import format.
- **Tailwind CSS v4 + shadcn/ui (Radix)** for chrome: menus, dialogs, popovers, breadcrumbs, toasts. The document-like surfaces (tables, canvas) are custom-styled; shadcn is only for interactive chrome. Light/dark themes via CSS variables (SPEC §4.7).
- **Tooling**: TypeScript `strict`, ESLint 9 (flat config) + typescript-eslint, Prettier. Definition of done per global rules: `npx tsc --noEmit` and `npx eslint . --quiet` clean.
- **Testing**: Vitest (+ Testing Library) for store, layout purity, and invariant property tests; Playwright for canvas interaction and in-place editing flows (SPEC §7).

---

## 6. AWS deployment picture

```text
v1 (now)                                    v2 (collaboration)
────────────────────────                    ─────────────────────────────────────
S3 bucket (static build)                    same static frontend
  └─ CloudFront (+ ACM cert)                + Lightsail 2GB instance:
~$0–1 / month                                   Postgres 17
Database: PGlite in-browser ($0)                Electric sync OR Supabase (self-hosted)
                                                auth service (better-auth or Supabase)
                                            ~$10–15 / month all-in
```

Route 53 (~$0.50/zone) if a custom domain is wanted. No other AWS services required. Everything on the server side is open source and portable off AWS unchanged.

---

## 7. Version pins (at project start)

| Package | Version line |
| --- | --- |
| Node | 22 LTS |
| React / React DOM | 19.x |
| TypeScript | 5.x (strict) |
| Vite | 7.x |
| @electric-sql/pglite | 0.3.x |
| drizzle-orm / drizzle-kit | latest 0.4x line |
| @tanstack/react-table | 8.x |
| @dnd-kit/core | 6.x |
| zustand | 5.x |
| zod | 4.x |
| d3-shape | 3.x |
| tailwindcss | 4.x |
| vitest / playwright | latest stable |

Exact pins land in `package.json` at M1; this table records the intended major lines. Renovate/dependabot optional but recommended from M1.

---

## 8. Decision log

| # | Decision | Alternatives rejected | Revisit when |
| --- | --- | --- | --- |
| T1 | Postgres-everywhere via PGlite | SQLite+dual dialect; DynamoDB; MySQL | PGlite bundle size or perf becomes a real user problem |
| T2 | TanStack Table + custom cells | AG Grid (tree = paid), Glide (canvas grid), Handsontable (license) | Row counts exceed ~10k per table (consider virtualization via @tanstack/react-virtual first) |
| T3 | Hand-rolled SVG canvas; collisions via synchronous `d3-force` inside the pure layout fn | visx, full d3, konva; free-running physics | **Designated fallback: React Flow (xyflow)** if M2 pan/zoom/drag interaction work overruns — layout stays a pure function feeding either renderer |
| T4 | PWA over Tauri | Tauri + SQLite | A hard native requirement appears (file-system watching, offline installers for enterprise) |
| T5 | Lightsail Postgres for v2 | RDS, Aurora Serverless | Backup/patching toil > cost delta, or multi-AZ needed |
| T6 | Electric vs Supabase for sync | — | Deliberately deferred to v2 kickoff; both satisfy "row deltas, LWW, no positions on the wire" |
| T7 | Relational schema over graph/NoSQL DB | Neo4j (GPLv3, server-only, no $0 v1), Neptune (proprietary, ~$70+/mo), MongoDB (SSPL), CouchDB (no multi-key constraints), Kùzu (development halted 2025) | Escape hatch without migration: Apache AGE extension adds openCypher inside Postgres if deep traversal queries ever appear |
