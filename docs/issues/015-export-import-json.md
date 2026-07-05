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

## Test-first plan

1. Property test: random projects (all entity types, recursion depth ≤ 4) → export → import → deep-equal modulo ids; re-export of the import is byte-stable.
2. Unit: id remap preserves every FK relation (bindings, source links, parent chains) — checked by graph isomorphism on fixtures.
3. Unit: tampered file (missing table, wrong version, cyclic parent) rejected atomically with a named error.
4. e2e: export the seeded example → wipe browser storage → import → register, canvas, and coverage identical (visual snapshot).

## Acceptance criteria

- [ ] Round-trip property test in `npm run verify`.
- [ ] Import never partially applies (transaction).
- [ ] The JSON format is documented in this file's appendix once implemented and is the only supported backup format for v1.
