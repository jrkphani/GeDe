# packages/core — conventions

The framework-free domain of GeDe: lattice index, A1 addressing, dependency graph, formula grammar,
text algebra. Consumed by `apps/web` (main thread and Workers) and `services/sync`.
Read the root `CLAUDE.md` first.

## Framework-free rule

- No imports from `react`, `react-dom`, `yjs` bindings to React, the DOM (`document`, `window`, `HTMLElement`), or Node-only modules (`fs`, `path`, `crypto` beyond `globalThis.crypto`, `Buffer`).
- Everything here must run unchanged in a browser Web Worker and in Node 22. `tsconfig` `lib` is `ES2023` only, no `DOM`. If a function needs a DOM API it belongs in `apps/web`.
- Public API is message-shaped where it will be called from a Worker: plain objects in, plain objects out, no class instances across the boundary.

## Constants and identity

- The lattice is 160 × 22 px. `LATTICE_COL = 160`, `LATTICE_ROW = 22` live here and nowhere else; `packages/tokens` mirrors them as CSS custom properties for chrome, this package is the source for geometry.
- Ids are ULIDs (`ulid`), generated client-side for sheets, tables, columns, rows, graphs. Every reference between objects stores an id.
- A1 addresses are computed from lattice position and never stored. `addressOf(cellId)` and `cellAt('B14')` are projections over the sparse lattice index; the index is rebuilt on structural edits (insert, delete, hide, wrap) and addresses recompute (GRID-02, HIER-09, RESP-01).

## Dependency graph

- Keyed by cell id, never by address. Dirty marking, pull-based lazy evaluation, topological batches per input event, explicit cycle detection that yields the `circular` error value (FX-06).
- Evaluation order must equal topological order; no stale reads after a structural edit. Property-based tests for these invariants are welcome (`fast-check` is an acceptable dev dependency).

## Formula grammar

- The grammar is the PRD's (§13, §22): `=Concat(a, b, …)`, `=Sum(range | list | @paths | column)`, lists `=A2, D5` and `=@Path, @Path` with any typed separator, `@` entity paths with dotted segments (quoted when they contain spaces or dots), quoted string literals, ranges `B2:B14` and whole columns `B:B`.
- The set operators (FX-09, ADR-053): `=Union(a, b, …)`, `=Inter(a, b, …)`, `=Diff(a, b, …)`, `=Comp(a, u)`, `=Cross(a, b, …)` over the strings in cells — `formula/sets.ts` is the algebra, the evaluator only plumbs operands into it. Names commit in canonical spelling; the aliases live in the parser's name map and nowhere else.
- Function names and A1 addresses are ASCII in every locale; `@` paths may contain any script.
- The parser reports error positions. Sum over a text cell yields the `text_in_range` error naming the offender; mixed currencies yield an error, never a conversion (FMT-03, FX-02).

## Error values

Errors are values, not exceptions. Evaluation returns a `Result<Value, FormulaError>`; `FormulaError` carries `kind` (`circular`, `text_in_range`, `mixed_currency`, `invalid_format`, `parse`, `unknown_reference`, `arity`, `too_many_tuples`), a message and, where relevant, the offending cell id. Throwing from evaluation is a defect.

## Text algebra

Split, Extract, Replace, Format and Concat operate on a mark-preserving rich-text type compatible with the ProseMirror schema. Marks survive every operation; property tests should assert it.

## Performance budgets (PRD §20)

| Scenario                                 | Budget  |
| ---------------------------------------- | ------- |
| Keystroke to visible update, 1,000 cells | 16 ms   |
| Pan and zoom, 10,000 cells on the sheet  | 60 fps  |
| Recompute of a 500-row dependent chain   | < 50 ms |

Benchmarks live beside the code as `*.bench.ts` (vitest bench) and are not part of `npm run verify`.

## Tests

Vitest, no jsdom. Test names start with the requirement id where one applies (`test('FX-06 depth guard reports circular', …)`).
