/**
 * Id-bound references (PRD §20 "every reference in §13 and §14 stores ids;
 * A1 addresses are a presentation projection recomputed from the lattice").
 *
 * The stored formula is a string (`isFormula` still holds), but every
 * reference the person typed as an address, range, column or `@` path is
 * bound to ids at commit time and written as a token:
 *
 *   {c:T:R:C}            a cell, spelled as an address when projected (`B14`)
 *   {e:T:R:C}            a cell, spelled as an entity path (`@Table.Row.Column`)
 *   {r:T:R1:C1:R2:C2}    a range: two corner cells of one table; the interior
 *                        is whatever rows and columns lie between them now.
 *                        A corner that reached past the table at commit is
 *                        open-ended: `^` = the table's first row/column,
 *                        `*` = its last, so `=Sum(B5:B20)` over a five-row
 *                        table follows the table as rows come and go
 *   {k:T:C|T:C}          a lattice column: the table columns that sat under it
 *
 * T, R and C are ULIDs. The kind letter is the grammar version: a new shape
 * takes a new letter and an existing letter keeps decoding forever, so a
 * document written today reads tomorrow without a migration. A token typed
 * or pasted by hand binds like any other (it is the parser's grammar, not a
 * hidden one); inside quotes it is text. Display projects the tokens back to A1 / `@` from the
 * current geometry, so inserting a row above `B6` shows `B7` and still reads
 * the same cell. A token whose target is gone projects as `#REF` and
 * evaluates to `⚠ reference removed`.
 *
 * An address that named empty canvas at commit time has no id to bind to and
 * stays as typed; it resolves through the geometry until it is re-committed.
 */
import type { Id } from '../ids.js';

export interface BoundCell {
  readonly kind: 'cell';
  readonly tableId: Id;
  readonly rowId: Id;
  readonly colId: Id;
  /** How the person wrote it, so projection can write it back the same way. */
  readonly spelling: 'address' | 'entity';
}

/** `^` the table's first row or column, `*` its last: a corner that reached past the table. */
export type OpenCorner = '^' | '*';
// `Id` is `string`, so the union is documentary: a corner is a ULID or one of the two edge markers.
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
export type CornerId = Id | OpenCorner;

export interface BoundRange {
  readonly kind: 'range';
  readonly tableId: Id;
  readonly from: { readonly rowId: CornerId; readonly colId: CornerId };
  readonly to: { readonly rowId: CornerId; readonly colId: CornerId };
}

export function isOpenCorner(id: CornerId): id is OpenCorner {
  return id === '^' || id === '*';
}

export interface BoundColumn {
  readonly kind: 'column';
  /** Every table column that occupied the lattice column at commit time. */
  readonly columns: readonly { readonly tableId: Id; readonly colId: Id }[];
}

export type BoundReference = BoundCell | BoundRange | BoundColumn;

const ID = '[0-9A-Z]{26}';
const CORNER = `(?:${ID}|\\^|\\*)`;
/** Whole-token grammar. Anything else in braces is separator text, not a token. */
export const BOUND_RE = new RegExp(
  `^\\{(?:[ce]:${ID}:${ID}:${ID}|r:${ID}:${CORNER}:${CORNER}:${CORNER}:${CORNER}|k:${ID}:${ID}(?:\\|${ID}:${ID})*)\\}$`,
);

export function encodeBound(ref: BoundReference): string {
  switch (ref.kind) {
    case 'cell':
      return `{${ref.spelling === 'entity' ? 'e' : 'c'}:${ref.tableId}:${ref.rowId}:${ref.colId}}`;
    case 'range':
      return `{r:${ref.tableId}:${ref.from.rowId}:${ref.from.colId}:${ref.to.rowId}:${ref.to.colId}}`;
    case 'column':
      return `{k:${ref.columns.map((c) => `${c.tableId}:${c.colId}`).join('|')}}`;
  }
}

/** Decode one token. Returns null for anything that is not a well-formed bound token. */
export function decodeBound(text: string): BoundReference | null {
  if (!BOUND_RE.test(text)) return null;
  const body = text.slice(1, -1);
  const kind = body[0];
  const rest = body.slice(2);
  switch (kind) {
    case 'c':
    case 'e': {
      const [tableId = '', rowId = '', colId = ''] = rest.split(':');
      return { kind: 'cell', tableId, rowId, colId, spelling: kind === 'e' ? 'entity' : 'address' };
    }
    case 'r': {
      const [tableId = '', r1 = '', c1 = '', r2 = '', c2 = ''] = rest.split(':');
      return {
        kind: 'range',
        tableId,
        from: { rowId: r1, colId: c1 },
        to: { rowId: r2, colId: c2 },
      };
    }
    case 'k':
      return {
        kind: 'column',
        columns: rest.split('|').map((pair) => {
          const [tableId = '', colId = ''] = pair.split(':');
          return { tableId, colId };
        }),
      };
    default:
      return null;
  }
}

/** Spelling of a reference whose target no longer exists. */
export const REMOVED_REFERENCE_TEXT = '#REF';
/** Spelling of a reference whose target exists but has no lattice address (a hidden column, GRID-02). */
export const HIDDEN_REFERENCE_TEXT = '#hidden';
