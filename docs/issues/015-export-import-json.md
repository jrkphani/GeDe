# 015: Project export/import (JSON)

- **Status**: OPEN
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

## Test-first plan

1. Property test: random projects (all entity types, recursion depth ≤ 4) → export → import → deep-equal modulo ids; re-export of the import is byte-stable.
2. Unit: id remap preserves every FK relation (bindings, source links, parent chains) — checked by graph isomorphism on fixtures.
3. Unit: tampered file (missing table, wrong version, cyclic parent) rejected atomically with a named error.
4. e2e: export the seeded example → wipe browser storage → import → register, canvas, and coverage identical (visual snapshot).

## Acceptance criteria

- [ ] Round-trip property test in `npm run verify`.
- [ ] Import never partially applies (transaction).
- [ ] The JSON format is documented in this file's appendix once implemented and is the only supported backup format for v1.
