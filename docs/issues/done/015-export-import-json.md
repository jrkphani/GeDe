# 015: Project export/import (JSON)

- **Status**: SHIPPED
- **Milestone**: M6
- **Blocked by**: 011, 014

## Slice

As a designer I export a whole project to one JSON file and import it elsewhere, losslessly. This is also the backup story for browser-resident data (ADR-0006 mitigation) — it must exist before any real design work is trusted to the app.

## Scope

- Zod-versioned envelope (`formatVersion: 1`) covering all entities across all tiers and recursion depths; no derived data (no positions, no coverage).
- Export: single `.gede.json` download. Import: new project from file; id remapping (fresh UUIDs) while preserving all internal references.
- Rejection path: schema-invalid or future-version files produce a clear, specific error — never a partial import.

## Design brief

- **Placement**: export lives in the project menu ("Export project…") and downloads `{project-name}.gede.json` immediately — no options screen. Import lives on the projects list: a button plus drag-a-file-anywhere onto the list panel (drop target highlights with the accent wash + dashed hairline).
- **Import lands safely**: always a *new* project (never merges/overwrites); on success the list selects it with the status line "Imported *Tavalo* — 4 canvases, 23 contexts".
- **Error states are specific and calm**: wrong file type → "Not a GeDe export"; newer format → "This file is from a newer version of GeDe — update to open it"; corrupted → "File damaged at `contexts[4]` — nothing was imported". Errors render in the panel, not as dialogs; nothing partial ever appears in the list.
- **Progress**: no spinner under 150ms (typical files parse instantly); large files show a one-line inline progress note, never a blocking overlay.
- **Trust surface**: this is the v1 backup story (ADR-0006) — the projects list footer quietly notes "Projects live in this browser. Export to back up." on first visit (dismissable, remembered).
- **Offline**: both directions are fully offline — worth asserting in the e2e since it proves the PWA claim end to end.

**References**: SPEC §4.7 · SITEMAP §2 (project menu owns Export/Import; status bar owns the backup note) · STYLE_GUIDE §2.2 (wash), §9 · TECH_STACK §2 (PGlite), §5 · ADR-0006

> **UI build convention (018–020):** compose the shared `src/components/ui/` primitives — `Button`, `InlineEdit`/`PhantomInput`, `Popover`, `Command`, `Swatch`, `Input` — and reuse `EditableGrid` for any tabular view; style only via design tokens. No hand-rolled `<button>`/`<input>` or hardcoded colors (lint-enforced — see ADR-0007 · STYLE_GUIDE §11).

## Test-first plan

1. Property test: random projects (all entity types, recursion depth ≤ 4) → export → import → deep-equal modulo ids; re-export of the import is byte-stable.
2. Unit: id remap preserves every FK relation (bindings, source links, parent chains) — checked by graph isomorphism on fixtures.
3. Unit: tampered file (missing table, wrong version, cyclic parent) rejected atomically with a named error.
4. e2e: export the seeded example → wipe browser storage → import → register, canvas, and coverage identical (visual snapshot).

## Acceptance criteria

- [x] Round-trip property test in `npm run verify`.
- [x] Import never partially applies (transaction).
- [x] The JSON format is documented in this file's appendix once implemented and is the only supported backup format for v1.

---

## Appendix — the `.gede.json` v1 format (the only supported v1 backup format)

A GeDe export is a single UTF-8 JSON file, conventionally named `{project-name}.gede.json`. Its shape is defined by a Zod schema in `src/domain/projectEnvelope.ts` (`FORMAT_VERSION = 1`). The importer validates against that schema and rejects anything else — this appendix is descriptive; the schema is authoritative.

### Envelope

```jsonc
{
  "formatVersion": 1,          // integer. > 1 ⇒ "newer version" rejection; ≠ 1 ⇒ "not a GeDe export"
  "tables": {                  // exactly these 9 keys, each an array of rows
    "projects":      [ … ],    // exactly one row (the project being exported)
    "tier1_purpose": [ … ],
    "tier1_props":   [ … ],
    "tier2_tables":  [ … ],
    "tier2_entries": [ … ],
    "dimensions":    [ … ],
    "parameters":    [ … ],
    "contexts":      [ … ],
    "bindings":      [ … ]
  }
}
```

The table keys are the SQL table names (`src/db/schema.ts`); the 9 tables are the entire SPEC §3 row set. A schema-coverage test (`src/db/projectIO.test.ts`) cross-checks this list against `getTableName` over the live Drizzle schema, so **adding a `pgTable` without extending the envelope fails the build** — the envelope can never silently drop a table.

### Row shapes

Rows are the Drizzle `$inferSelect` shape verbatim (camelCase keys), one object per column in `schema.ts`. Every row carries `id`, `createdAt`, `updatedAt`, and (except `bindings`) `deletedAt` — all preserved, so an export is a faithful clone including soft-deleted rows and LWW timestamps. Foreign keys, by table:

| Table | FK / id columns (beyond `id`) |
| --- | --- |
| `tier1_purpose` / `tier1_props` / `tier2_tables` | `projectId` → projects |
| `tier2_entries` | `tableId` → tier2_tables · `parentId` → tier2_entries *(self)* |
| `dimensions` | `projectId` · `contextId` → contexts · `sourceParamId` → parameters *(cross-link)* |
| `parameters` | `dimensionId` · `parentParamId` → parameters *(self)* · `sourceEntryId` → tier2_entries *(cross-link)* |
| `contexts` | `projectId` · `parentId` → contexts *(self)* |
| `bindings` | `contextId` · `dimensionId` · `parameterId` · plus stored `tupleHash` |

### What is and isn't included

- **Included**: every stored column, including `bindings.tupleHash` (a stored column, SPEC §3) and soft-deleted rows.
- **Excluded (SPEC invariant 5 — derived, never stored)**: canvas geometry / x-y positions, spoke routing, coverage — none of it appears in the file. Layout is recomputed on load.

### Serialization is deterministic

Rows are emitted sorted by `id`, fields in schema order, so re-exporting the same project yields byte-identical output (round-trip test #1).

### Import semantics

1. **Validate** (`parseEnvelope`) before touching the DB — typed, calm rejections: `NotGeDeExportError` ("Not a GeDe export"), `NewerVersionError` ("This file is from a newer version of GeDe — update to open it"), `CorruptedEnvelopeError` ("File damaged at `contexts[4]` — nothing was imported"). Validation covers the schema, referential integrity (no dangling FK), and self-referential acyclicity (no cyclic parent chains).
2. **Remap** every id to a fresh UUIDv7 and rewrite every reference (`remapEnvelope`) — a global old→new map drives pk, fk, self-ref, and cross-link fields uniformly.
3. **Write atomically** (`importProject`) inside one `db.transaction`. Insert order sidesteps the schema's non-deferrable FK cycles by inserting the self-referential parent columns and the `dimensions.sourceParamId` cross-cycle column as NULL, then setting them in a second UPDATE pass once every row exists. Any failure rolls the whole thing back — an import **never partially applies**, and always creates a **new** project (fresh id), never merges or overwrites.

### Implementation map

- `src/domain/projectEnvelope.ts` — pure: Zod schema, serialize, id-remap, validation + typed errors, stats.
- `src/db/projectIO.ts` — `gatherProjectRows` (export read) + `importProject` (atomic transactional write).
- `src/store/projects.ts` — `exportProject` / `importProject` store actions.
- `src/shell/AppShell.tsx` — project-menu "Export project…".
- `src/components/ProjectsList.tsx` — Import button + drag-drop, in-panel errors, first-visit backup note.
