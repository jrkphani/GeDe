/**
 * Cross-table references in the document route (PRD §14; REF-01..REF-05;
 * HIER-07 `Split()` children).
 *
 * ── Cells (mounted by the grid's Cell) ────────────────────────────────────
 *   refCellKind(column, rowMeta, source) → 'derived' | 'mapping' | 'pulled' | 'reference' | null
 *   <ReferenceCell table cell kind expression />   an `@` pick or a pulled cell: accent mono,
 *                                                  badge, path beneath (wrapped row)
 *   <DerivedCell table cell spec expression />     the engine's result for a derived column
 *   <MappingCell table cell link … ref />          a Radix Select over the target's distinct values
 *   <LineageHeader record />                       the lineage bands, in the title bar
 *   useReferenceReconciler(doc, editable)          pulls and Split children stay materialised
 *
 * ── Inspector (Format — Derive) — for the integrator ──────────────────────
 *   <DerivedColumnPanel gd tableId sourceColId? undo? editable? />   REF-04 (partial: the
 *                                                  inspector composes it; see the panel test)
 *   <PullPanel gd tableId undo? editable? />       REF-02
 *   <MappingColumnPanel gd tableId undo? editable? />   REF-03
 *   <DerivePanel …/>                               the three, stacked
 *
 * ── Guard — for the graph agent ───────────────────────────────────────────
 *   `isGraphDimensionCandidate(column)` and `cellReadOnlyReason` come from `@gede/core`.
 */
export { refCellKind, type RefCellKind } from './cell-kind.js';
export { ReferenceCell, type ReferenceCellProps } from './ReferenceCell.js';
export { DerivedCell, type DerivedCellProps } from './DerivedCell.js';
export { MappingCell, type MappingCellHandle, type MappingCellProps } from './MappingCell.js';
export { LineageHeader, type LineageHeaderProps } from './LineageHeader.js';
export { useReferenceReconciler } from './use-reconcile.js';
export { DerivedColumnPanel, type DerivedColumnPanelProps } from './DerivedColumnPanel.js';
export { MappingColumnPanel, PullPanel } from './RelationPanels.js';
export { DerivePanel, type DerivePanelProps } from './DerivePanel.js';
