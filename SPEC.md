# SPEC — Set tables (ADR-056)

Requirements: SET-01..19 and FX-10 in `docs/REQUIREMENTS.md`. Decisions: ADR-056 in `docs/DECISIONS.md`. Design: the GeDe Sets canvas (owner's artifact). This spec covers how to build it; it does not restate the rows.

## 1. What "done" looks like

- A person adds a Simple set, types elements, and sees the meta row, the footer counts and the degree rail update as they type.
- `Fill column with formula…` with `=Cross(E, C, B)` in "One column per set" shape produces 18 rows on every replica, in the same order with the same row ids, and no replica writes again once they agree.
- A typed note beside the tuple `(a, b, x)` survives a reorder of `E`, and survives `x` leaving `B` as a dimmed "no longer in E × C × B" row.
- `npm run verify` and `npm run e2e` are green; every SET and FX-10 row has a test named with its id; the traceability report shows them covered.

## 2. The engine change: a formula fills rows

Nothing fills rows from a formula today. Two reconcilers already turn computed lists into rows and converge across replicas: pulls (`packages/core/src/ref/pull.ts`, REF-02) and `Split()` children (`ref/split.ts`, HIER-07). Both use `RowEditor` (`ref/rows.ts`) for minimal-diff edits, derive row ids deterministically, and write under their own transaction origin so they are never an undo step. A computed column is a third reconciler of the same shape. Do not invent a new mechanism.

### 2.1 Data

- `ColumnSource` (`doc/schema.ts:117`) gains `'computed'`. A table has exactly one computed formula, stored on the table as `TableRecord.computedFormula` (`setTableFormula`); every computed column follows a change to it in one step, and two concurrent changes converge on one formula (ADR-056 ruling a). A computed column stores only its role: `{ shape: 'column' | 'spread'; spreadIndex?: number; fill?: string }`. In `spread` shape the product fills one column per operand; each carries its `spreadIndex`, and all of a table's spread columns share one `fill` id. When the formula's number of sets changes, member columns are added or removed to match in the same step; typed neighbour columns are untouched (ruling b).
- A table record gains `kind: 'plain' | 'simple' | 'family' | 'computed' | 'product'`, default `'plain'`, so existing documents read unchanged. No migration is needed for Yjs content; if the sync service's Postgres projection (`packages/db`) indexes table metadata, add a migration for the new field there — never edit the schema directly.
- A row in a computed table gains `computedKey: string | null`, the element's or tuple's canonical text (FX-09 spelling, NFC). It is provenance, like `splitOf` and `pulledFrom`.
- A row gains `lostFrom: string | null`, set when its key left the result while the row holds typed values (SET-12). The label "no longer in E × C" is rendered from the column's formula operands, not stored.
- _Amended (Phase 2 ruling):_ a row gains `computedMembers: string[]`, written only when a tuple key cannot be split back into its members (a member with an unbalanced bracket, e.g. `sad :(`); a spread column reads its member from it. Internal row-meta keys `computedAfter` (the row a removed computed row followed, so a returning row comes back in place) and the table key `computedRows` (the table was filled at least once) are reconciler bookkeeping. A removed computed row keeps its meta and any cells it held, so a note typed on it concurrently brings it back; the grid's orphan sweep skips such cells (`orphanCellKeys`).

### 2.2 Row identity

Row id = `computedRowId(tableId, computedKey)`: FNV-1a 64 over `tableId + '\u0000' + key`, Crockford-encoded, the way `splitChildId` derives child ids from the parent's. The same key gives the same id on every replica, so two replicas reconciling at once insert the same id, `RowEditor.dedupe` settles the duplicate, and the next pass writes nothing.

A typed value in a neighbouring column lives on the row, keyed by row id, so it follows its key through any reorder (SET-11) with no extra bookkeeping.

A computed row, lost or not, cannot be deleted: `deleteRow` refuses a row with a `computedKey` and every Delete row control is disabled with “the row is computed” (ruling c). The table key `computedIds` records each row id the reconciler keyed, so a row an older client's delete left with no meta gets its key back.

### 2.3 Reconcile

`reconcileComputed(gd, tableId, result: readonly string[])` in a new `ref/computed.ts`, run under `COMPUTED_ORIGIN`:

1. Wanted ids = `result.map(key → computedRowId)`, in result order.
2. For each existing computed row not wanted: if any non-computed cell in it holds a typed value, set `lostFrom` and keep it in place; otherwise remove it.
3. For each wanted id: insert if missing, clear `lostFrom` if set (a key that comes back reclaims its row and its notes), and move it into result order.
4. ~~Write the computed cells' text.~~ _Amended (Phase 2 ruling):_ computed text is never written to the cells map. It is projected from the row's provenance when read (`computedCellText`, `computedCells` in `doc/schema.ts`): the key in `column` shape, the tuple member at `spreadIndex` in `spread` shape. Every reader (engine, grid, copy, Find, `@` index, sync projection) goes through the projection, so computed text and a person's text never share a cell key. A value typed under a computed column's key concurrently with Fill column stays in the document; the next reconcile refuses the Fill (SET-10) and sets the column back to entered, together with every other column made computed in the same Fill step (`setComputedColumns` stamps one `fill` id on them), so a tuple is never half filled and an earlier, settled Fill is untouched.

Lost rows keep their position among the wanted rows, so a person sees them where they were. Rows a person added by hand in a computed table are not computed rows; they stay where they are and their computed cells are empty and read-only.

### 2.4 Where it runs

The evaluator already runs in the Worker and returns `list` values for set formulas (ADR-053). The engine evaluates the table's one formula like any cell's (a synthetic cell on its first computed column) and hands `{ tableId, items, members }` to the main thread with its results, as it does for derived `Split` columns. The main thread calls `reconcileComputed` inside one transaction, after every batch of results and after every remote document update (ruling d), so merge-time repairs never wait for a result to change. The formula is evaluated once per table, not per column or row.

Cap: Cross keeps `MAX_CROSS_TUPLES = 10_000` (`formula/sets.ts:26`). `Power` reuses the cap (FX-10: 2¹³ subsets is the largest allowed). A refused result reconciles nothing — the table keeps its rows — and the column header shows the error with its message. _Amended (Phase 2 ruling):_ a table with no result to fill from (refused, an error, still evaluating, or no formula) is still handed off with `items: null`, so the reconciler keeps its rows sound without filling: a row inserted twice by two replicas is deduped, a Fill that met typed text is refused (SET-10), and a removed row holding typed text comes back, labelled lost (SET-12).

### 2.5 Power (FX-10)

`Power` joins `SET_FUNCTION_NAMES` (`formula/ast.ts:110`) with arity 1. Subsets render `{a, b}`. The splitter (`splitSetElements`) must treat braces like parentheses — a separator inside `{…}` does not split — so a Power result feeds another set function. Add `too-many-subsets` beside `too-many-tuples` in `FormulaError`.

## 3. Derived values that are not rows

All of these are pure functions in `packages/core`, recomputed in the Worker from the sheet's set tables. None of them is stored.

| Value                        | Inputs                        | Notes                                                                                                                                                 |
| ---------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cardinality, bag (SET-05)    | range column; family depth    | Distinct count under FX-09 equality; bag counts every entry and every leaf.                                                                           |
| Special status (SET-03)      | cardinality                   | null at 0, singleton at 1.                                                                                                                            |
| Finite, variable, quantifier | caption                       | Open question 1. Until decided they render “—”.                                                                                                       |
| U (SET-13)                   | every set table on the sheet  | First-seen order by sheet table order, then row order. Referenced as `@U`: the entity index (ADR-054) gains one synthetic table per sheet.            |
| Super set array (SET-14)     | U plus set table names        | Display only.                                                                                                                                         |
| Section summary (SET-15)     | the set tables in one section | Equality, ⊆ and ⊂ are pairwise, O(n²) set comparisons. The intersection, union and difference columns test pairs only, O(n³). Open question 3 caps n. |
| Sheet summary (SET-16)       | section summaries             | Counts only.                                                                                                                                          |

_Amended (Phase 5):_ `@U` resolves where `@E` does (`FormulaEngine.setCellsNamed`, scoped to the asking cell's sheet; a set titled `U` wins): there is no synthetic table in the entity index. U lists the element rows (a row with rows under it is a set, not an element) of every set table, product tuples included. The summaries, U and the super set array are pure functions in `doc/sheet-sets.ts`, drawn by `sets/SheetStructure.tsx` in a band under the sheet's tables (`structureLayout`); they are not addressable by A1 and take no row ids. The section summary's _similar definition_ column is the sets equal to it (SET-15); a pair never includes the set it is compared to.

Summary and U tables are rendered tables with no Yjs content: they are read-only, take no typed values, and have no row ids to converge. Their A1 positions are lattice positions like any table's, so they still occupy space and formulas can address them.

## 4. Sections and lock

- A section (SET-17) is a sheet-level record `{ id, name, firstColumn, lastColumn, locked }` in lattice columns. Pipeline lanes (INSP-07) creates one section per lane. Guide lines are drawn at `firstColumn` and `lastColumn + 1`; the gutter is the lattice column between two sections. A table belongs to the section containing its anchor column.
- _Amended (Phase 5):_ a section is the sheet map's key `section:<id>` holding its own `Y.Map` (`name`, `firstColumn`, `lastColumn`, `locked`), so two sections added apart both survive a merge and a rename and a lock made apart both stand; the sheet's lock is its `locked` key. There is no Pipeline lanes command (INSP-07 has none): Add section (the canvas menu) is the one route. A table put inside a section snaps within it (`setTablePosition`, `createTable`).
- Lock (SET-18) is a flag on a section or a sheet. Every mutation entry point that already checks `rowReadOnlyReason` or view-only access checks the lock first and returns the reason string. The check lives in `packages/core`, so the sync service can enforce it on received updates too; a client-only check is advisory and is not enough.
- _Amended (Phase 5), service side:_ `applyGuardedUpdate` (`doc/lock-guard.ts`) applies a received update to a copy of the document, reads the tables it changes off the copy's events, and — for a table locked before the update — puts the table back as it was in a broadcast write (`LOCK_RESTORE_ORIGIN`). The update is applied, not dropped, because a client's later updates build on its earlier ones. It counts as an edit when it adds or removes a table, changes a table's own keys, columns, formats or spans, or writes the text of a cell on a row a person owns. Adding or removing a row a person owns counts too, as does a table moved into a locked lane; a locked sheet deleted by a client is put back. It does not count: the reconcilers' bookkeeping keys, row order alone, and rows whose meta _before the update_ marks them pulled, split, followed or computed (an update cannot vouch for its own writes). A row the update itself adds is read by its own meta only in a machine-driven table (a computed formula or a non-entered column; a formula in a cell does not make one), and only when the tag is backed: a computed key needs the table's formula and a `computedIds` entry for the row, a pulled row needs a source table and row that exist and a pull spec on the receiving table; otherwise it is a person's row and is refused. Remaining limit: a split, followed or band tag on an added row is trusted in a machine-driven table. Graphs are not guarded.

## 5. Interface

- Add table opens the kind picker (SET-01). The computed kinds' second step is the operand picker drawn on the canvas's derive board.
- The column menu gains Fill column with formula… between Rename column… and Delete column (MENU-03 as amended).
- The meta row, title row and degree rail are presentation over the table's existing rows; they are not Yjs rows and do not shift A1 addresses (SET-07). The footer count strip is GRID-11's.
- Family of sets is a set table with hierarchy on; its kind column is computed from each row's depth and children (element, set or family).
- Copy: every new string goes into `apps/web/src/i18n` in all six locales with key parity (`catalogue.test.ts`), using SET-19's verbs. A test asserts that no catalogue value contains Create, Insert, New, Place or Choose as a button or menu label.

## 6. Phases

Each phase stays within five source files plus their tests, ends with `npm run verify` green, and waits for approval before the next.

1. **Power and braces.** FX-10: `ast.ts`, `parser.ts`, `sets.ts`, `evaluate.ts`, the forms menu. Property tests: |Power(A)| = 2^|A|, every subset re-splits to itself.
2. **Computed column reconciler.** Schema (`ColumnSource`, row provenance), `ref/computed.ts`, engine hand-off. Tests: two replicas reconciling concurrently converge with no further writes; a reorder keeps notes on their keys; a lost key with a note stays, without one leaves; a returning key reclaims its row.
3. **Fill column and Add table kinds.** Column menu entry, kind picker, operand picker, product shape. E2E: build `E × C × B` in both shapes and type a note beside a tuple.
4. **Set tables.** Meta row, degree rail, footer counts, repeat flag, Split-into-rows offer, family kind column.
5. **Sheet structure.** Sections, guides, lock with service-side enforcement, U and the `@U` entity, super set array, section and sheet summaries.
6. **Copy follow-ups.** Insert → Add in the toolbar table menu, the Cross hint, moving menu, inspector and toolbar strings into the catalogue.

## 7. Open questions

1. **Reading a definition.** SET-03 needs bound or free, the quantifier, and finite or infinite from the caption. Options: parse a small set-builder grammar (`{x | P(x)}`, `∀`, `∃`, "for all", "there exists"), or let the person set them in the Table tab. Until decided they show “—”.
2. **Infinite sets.** May a set be defined by a predicate alone, with no listed elements? If yes it cannot be an operand to a computed table, and the picker must say why.
3. **Summary cost.** The pairwise columns are O(n³) in sets per section. Cap the sets per section, or compute the three algebra columns only on demand?
4. **Computed tables and sort or filter.** HIER already disables Nest while a view is sorted or filtered. Does a computed table follow result order only, or may a person sort it as a view?
5. **Lock and the owner.** Can the owner edit a locked section without unlocking it, or does lock bind everyone?

### v1 defaults (2026-10-09, reversible)

Taken so the build is not blocked; each can be changed by a later ADR.

1. Bound/free, quantifier and finite/infinite render “—” unless the caption is set-builder notation the parser recognises (`{x | …}`, `∀`, `∃`, “for all”, “there exists”); no Table-tab override in v1.
2. No infinite sets in v1: every set table is finite and lists its elements.
3. The intersection, union and difference columns of a section summary are computed for sections of up to 30 sets; above that they read “—” with the reason “more than 30 sets in this section”.
4. A computed table keeps result order; Sort and Filter apply as views (SORT rows) and never change stored order.
5. Lock binds everyone, the owner included; anyone with edit access can unlock.
