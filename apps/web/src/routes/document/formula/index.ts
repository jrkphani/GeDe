/**
 * Formula UI for the document route (FX-01..FX-08, REF-01 consumer, A11Y-04).
 *
 * ── Storage contract (PRD §20) ────────────────────────────────────────────
 *   A formula cell holds a string whose references are bound to ids
 *   (`{c:T:R:C}`, `{r:…}`, `{k:…}`, `{e:…}`; see `packages/core` bound.ts).
 *   Every commit goes through `commitCellText` (GridCommands.commitCell does),
 *   which binds the typed A1 / `@` text once. Everything the person sees is
 *   projected from today's lattice: `projectSource(doc, stored)`.
 *
 * ── Cell rendering (FX-07) ────────────────────────────────────────────────
 *   <FormulaCell table cell expression />        the grid's Cell mounts this for formula cells
 *   useCellDisplay(table, key) → { isFormula, value, formula (projected), error, badge,
 *                                  operands, pending }   (pending until the Worker answers for this source)
 *   The editor's initial text for a formula cell is the projected expression.
 *
 * ── Editor adornments (FX-02, FX-04, FX-05) — mounted in RichCellEditor ────
 *   useFormulaAdornments({ table, colId, text, selectionStart, selectionEnd, anchor, onReplace })
 *     → { element, onKeyDown(e), onCellClickWhileEditing(address), inputProps, open }
 *   The editing store (`editing-store.ts`) publishes the open editor's draft; a cell pressed
 *   while a formula is being edited calls `insertClickedAddress(address)` instead of selecting.
 *
 * ── Outlines and health (FX-08) ───────────────────────────────────────────
 *   `FormulaLayer` (in DocumentShell, inside <Canvas>) outlines the selected or edited
 *   formula's operands from the draft or the stored source; `FormulaEngineBanner` reports
 *   a Worker that stayed down.
 */
export {
  entityQueryAt,
  insertReferenceAt,
  insertReferenceRefAt,
  isBareEquals,
  isFormulaInput,
  isReferenceDraft,
  replaceRange,
  separatorBefore,
  type Replacement,
} from './input.js';
export {
  badgeFor,
  displayOf,
  formatCellValue,
  useCellDisplay,
  type CellDisplay,
} from './use-cell-display.js';
export { FormulaCellContent, type FormulaCellContentProps } from './FormulaCellContent.js';
export {
  ReferenceOutlines,
  referenceColourVar,
  REFERENCE_COLOURS,
  useOperandsOf,
  type ReferenceOutlinesProps,
} from './ReferenceOutlines.js';
export { FormulaCell, type FormulaCellProps } from './FormulaCell.js';
export { FormulaEngineBanner } from './FormulaEngineBanner.js';
export {
  currentFormulaEditing,
  insertClickedAddress,
  registerFormulaEditor,
  resetFormulaEditingForTests,
  updateFormulaEditor,
  useFormulaEditing,
  type FormulaEditingState,
} from './editing-store.js';
export { FormulaLayer, type FormulaLayerProps } from './FormulaLayer.js';
export {
  useFormulaAdornments,
  type FormulaAdornments,
  type FormulaAdornmentsOptions,
  type KeyLike,
} from './use-formula-adornments.js';
export {
  FormulaEditorAdornments,
  type FormulaEditorAdornmentsHandle,
  type FormulaEditorAdornmentsProps,
} from './FormulaEditorAdornments.js';
export {
  columnFormatOf,
  docOf,
  isSummable,
  operandsOf,
  projectSource,
  sheetOfTable,
} from './workbook.js';
