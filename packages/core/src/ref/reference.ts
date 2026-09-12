/**
 * Reference cells (REF-01, PRD §14 "any cell can become a direct reference
 * to another table's cell via the `@` entity index, without a formula").
 *
 * A reference cell is stored as the smallest formula there is: one
 * `{e:T:R:C}` token (ADR-023), so it evaluates, projects and re-binds like
 * every other reference. Nothing new is persisted; this module only decides
 * what counts as one and writes it.
 */
import { setCellText } from '../doc/mutations.js';
import type { GedeDoc } from '../doc/schema.js';
import { references } from '../formula/ast.js';
import { encodeBound, type BoundCell } from '../formula/bound.js';
import { parse } from '../formula/parser.js';
import type { Id } from '../ids.js';

/** The target a reference cell points at: a cell in any table on any sheet. */
export interface ReferenceTarget {
  readonly tableId: Id;
  readonly rowId: Id;
  readonly colId: Id;
}

/** The stored form of a reference cell pointing at `target`. */
export function referenceSource(target: ReferenceTarget): string {
  const cell: BoundCell = { kind: 'cell', ...target, spelling: 'entity' };
  return `=${encodeBound(cell)}`;
}

/**
 * The target when `source` is a reference cell — a formula that is exactly
 * one entity-spelled bound cell and nothing else — else null. A formula the
 * person typed as `=@Table.Row` binds to the same shape on commit, so it
 * counts too; `=@A.B, @C.D` or `=Sum(@A.B)` do not.
 */
export function referenceTargetOf(source: string): ReferenceTarget | null {
  if (!source.startsWith('=') || !source.includes('{e:')) return null;
  const cached = targets.get(source);
  if (cached !== undefined) return cached;
  const target = parseTarget(source);
  if (targets.size > 5000) targets.clear();
  targets.set(source, target);
  return target;
}

/** Stored source → target, so the grid's per-render check never re-parses a cell (REF-01). */
const targets = new Map<string, ReferenceTarget | null>();

function parseTarget(source: string): ReferenceTarget | null {
  const parsed = parse(source);
  if (!parsed.ok || parsed.value.kind !== 'list') return null;
  if (parsed.value.items.length !== 1) return null;
  const refs = references(parsed.value);
  const only = refs[0];
  if (refs.length !== 1 || only?.kind !== 'bound') return null;
  const ref = only.ref;
  if (ref.kind !== 'cell' || ref.spelling !== 'entity') return null;
  return { tableId: ref.tableId, rowId: ref.rowId, colId: ref.colId };
}

export function isReferenceSource(source: string): boolean {
  return referenceTargetOf(source) !== null;
}

/**
 * Turn a cell into a live reference to `target` (REF-01). One transaction,
 * one undo step; false when the row or column went away. The caller checks
 * the cell is editable (`cellReadOnlyReason`), as for any commit.
 */
export function setReferenceCell(
  gd: GedeDoc,
  tableId: Id,
  rowId: Id,
  colId: Id,
  target: ReferenceTarget,
): boolean {
  return setCellText(gd, tableId, rowId, colId, referenceSource(target));
}
