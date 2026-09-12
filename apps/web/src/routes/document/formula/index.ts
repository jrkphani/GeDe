/**
 * Formula UI for the document route (FX-01..FX-08, REF-01 consumer, A11Y-04).
 *
 * Contract for the grid editor (branch wave2/grid-editing). Everything the
 * editor needs is exported here; nothing in this folder touches TableView,
 * CellEditor, Inspector or Toolbar.
 *
 * ── Cell rendering (FX-07) ────────────────────────────────────────────────
 *   const display = useCellDisplay(table, cellKey);
 *     → { isFormula, value, formula, error: {label, message} | null, badge, operands, pending }
 *   <FormulaCellContent display={display} />          value + badge + expression line
 *   The editor's initial text for a formula cell is `display.formula` (the
 *   expression, never the value). `display.value` is already locale-formatted.
 *
 * ── Editor adornments (FX-02, FX-04, FX-05) ──────────────────────────────
 *   const a = useFormulaAdornments({ gd, table, colId, text, selectionStart,
 *                                   selectionEnd, anchor: textareaEl, onReplace, enabled });
 *   {a.element}                                        render beside the textarea
 *   onKeyDown={(e) => { if (a.onKeyDown(e.nativeEvent)) return; …KEYS-06… }}
 *   <textarea {...a.inputProps} …>                     ARIA for the listbox
 *   a.onCellClickWhileEditing(address)                 when a cell is clicked mid-edit;
 *                                                      the shell has the address via cellAddress()
 *   onReplace({ text, caret }) → set the textarea value and put the caret at `caret`; keep editing.
 *   `FormulaEditorAdornments` is the same as a component with a ref handle.
 *   `isFormulaInput(text)` says whether the draft will be stored as a formula.
 *
 * ── Outlines (FX-08) ─────────────────────────────────────────────────────
 *   `FormulaLayer` is mounted once in DocumentShell inside <Canvas>. Pass it
 *   `draft` (the live editor text) and it outlines the operands as they are
 *   typed. `ReferenceOutlines` + `useDraftOperands` are the pieces.
 *
 * ── Interim ──────────────────────────────────────────────────────────────
 *   Until the grid's Cell renders `FormulaCellContent`, `FormulaLayer` paints
 *   an overlay over every formula cell so FX-07 is visible end to end.
 */
export {
  entityQueryAt,
  insertReferenceAt,
  insertReferenceRefAt,
  isBareEquals,
  isFormulaInput,
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
  useDraftOperands,
  type ReferenceOutlinesProps,
} from './ReferenceOutlines.js';
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
  entityIndexOf,
  operandsOfDraft,
  sheetIndexOf,
  sheetOfTable,
} from './workbook.js';
