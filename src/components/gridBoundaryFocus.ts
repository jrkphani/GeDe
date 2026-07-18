// The shared grid-boundary focus/order seam. Two consumers speak this one
// vocabulary: the shipped `?d3rf` `WorkspaceCanvas` (cross-NODE Tab between the
// decomposed Architecture table nodes) and the upcoming 084-D3 Architecture
// chain adapter (cross-TABLE Tab within the stacked `ArchitectureSurface`).
// Extracting it here keeps the two `onExitBoundary` consumers on identical edge
// semantics — a table's forward boundary is its add-entry phantom, its backward
// boundary is its first editable cell — rather than each re-deriving them.
//
// The DOM helpers (`firstEditableCell` / `lastEditablePosition`) are extracted
// verbatim from WorkspaceCanvas's former inline helpers; the chain helpers
// (`chainOrder` / `resolveExitTarget`) are the NEW pure 084-D3 traversal.

// ── DOM focus helpers ─────────────────────────────────────────────────────────
// A table node's DOM is a `.react-flow__node` (WorkspaceCanvas) or a
// `#t2-table-<id>` section (084-D3); within it we land focus on the FIRST
// editable grid cell (forward entry) or the LAST editable position — the phantom
// "add entry" row (backward entry / add-entry). These queries are scoped to the
// passed section, so the caller decides which table's DOM to search.

/**
 * The first focusable editable position inside a table `section`: the first
 * editable grid cell, or — when the table has no data rows — the phantom
 * "add entry" input. `null` when the section has neither (e.g. read-only).
 */
export function firstEditableCell(section: HTMLElement): HTMLElement | null {
  const cell = section.querySelector<HTMLElement>(
    '.editable-grid tbody tr[data-row-id] .grid-cell[tabindex]',
  )
  if (cell) return cell
  // Empty table: the only editable position is the phantom row's input.
  return section.querySelector<HTMLElement>('.grid-row--phantom input')
}

/**
 * The last focusable editable position inside a table `section`: the phantom
 * "add entry" input (visually + tab-order last), or — when there is no phantom
 * (e.g. read-only) — the last editable grid cell. `null` when neither exists.
 */
export function lastEditablePosition(section: HTMLElement): HTMLElement | null {
  // The phantom "Name an entry" input is visually + tab-order last.
  const phantom = section.querySelector<HTMLElement>('.grid-row--phantom input')
  if (phantom) return phantom
  const cells = section.querySelectorAll<HTMLElement>(
    '.editable-grid tbody tr[data-row-id] .grid-cell[tabindex]',
  )
  return cells[cells.length - 1] ?? null
}

// ── Pure chain order + neighbor resolution (084-D3) ──────────────────────────
// The Architecture column is one flat focus chain: each table contributes an
// `:in` (its first editable cell) then an `:out` (its add-entry phantom), and
// the whole column ends with the single trailing add-table phantom `t2phantom`.

/** A table's boundary-chain id for its first editable cell (forward entry). */
export function tableInId(id: string): string {
  return `t2tbl:${id}:in`
}

/** A table's boundary-chain id for its add-entry phantom (its forward boundary). */
export function tableOutId(id: string): string {
  return `t2tbl:${id}:out`
}

/** The single trailing add-table phantom that closes the Architecture chain. */
export const CHAIN_PHANTOM_ID = 't2phantom'

/**
 * The flattened cross-table chain order (recomputed each render by the chain
 * adapter): `[t2tbl:X:in, t2tbl:X:out, …]` for each table in `sort` order, then
 * the trailing `t2phantom`.
 */
export function chainOrder(tables: { id: string }[]): string[] {
  return tables.flatMap((t) => [tableInId(t.id), tableOutId(t.id)]).concat(CHAIN_PHANTOM_ID)
}

/**
 * Given a table's boundary id and an exit direction, the neighbor chain id to
 * focus — pure, no DOM:
 *   • forward from `t2tbl:X:out` → the next table's `:in`, or `t2phantom` when X
 *     is the last table;
 *   • backward from `t2tbl:X:in` → the previous table's `:out`, or `null` when X
 *     is the first table (the true start edge).
 * Returns `null` for any id/direction that is not a recognized boundary.
 */
export function resolveExitTarget(
  id: string,
  dir: 'forward' | 'backward',
  tables: { id: string }[],
): string | null {
  if (dir === 'forward') {
    // Forward boundary is a table's add-entry phantom (`:out`).
    const i = tables.findIndex((t) => id === tableOutId(t.id))
    if (i === -1) return null
    const next = tables[i + 1]
    return next ? tableInId(next.id) : CHAIN_PHANTOM_ID
  }
  // Backward boundary is a table's first editable cell (`:in`).
  const i = tables.findIndex((t) => id === tableInId(t.id))
  if (i === -1) return null
  const prev = tables[i - 1]
  return prev ? tableOutId(prev.id) : null
}
