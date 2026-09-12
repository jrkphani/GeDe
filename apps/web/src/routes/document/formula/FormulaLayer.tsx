import { cellsMap, isFormula, type GedeDoc, type Id } from '@gede/core';

import { useEngineStatus } from '../../../doc/engine.js';
import type { CellSelection } from '../selection.js';
import { useFormulaEditing } from './editing-store.js';
import { ReferenceOutlines, useOperandsOf } from './ReferenceOutlines.js';

export interface FormulaLayerProps {
  gd: GedeDoc;
  sheetId: Id | null;
  zoom: number;
  /** The armed cell: its operands are outlined while it is a formula (FX-08). */
  selected: CellSelection | null;
  /** The cell whose editor is open; its live draft comes from the editing store. */
  editing: CellSelection | null;
}

/**
 * Mounted once inside `<Canvas>` (after the tables, so it paints above them):
 * reference outlines for the selected or edited formula cell (FX-08). While
 * an editor is open the outlines follow its draft keystroke by keystroke;
 * otherwise they follow the stored formula, projected to today's lattice.
 * Also carries the engine's transport mode for the journeys to assert.
 */
export function FormulaLayer({ gd, sheetId, zoom, selected, editing }: FormulaLayerProps) {
  const status = useEngineStatus(gd.doc);
  const live = useFormulaEditing();
  const focus = editing ?? selected;
  const focusTable = focus === null ? null : (gd.tables.get(focus.tableId) ?? null);
  const stored =
    focusTable === null || focus === null
      ? undefined
      : cellsMap(focusTable).get(`${focus.rowId}:${focus.colId}`);
  const draft =
    editing !== null &&
    live !== null &&
    live.tableId === editing.tableId &&
    live.rowId === editing.rowId &&
    live.colId === editing.colId
      ? live.draft
      : null;
  const formula = draft ?? (isFormula(stored) ? stored : null);
  const operands = useOperandsOf(gd.doc, sheetId, formula, draft === null);
  return (
    <>
      <span
        hidden
        data-testid="formula-engine"
        data-mode={status.mode}
        data-restarts={status.restarts}
        data-failed={status.failed}
      />
      {formula !== null && operands.length > 0 && (
        <ReferenceOutlines operands={operands} zoom={zoom} />
      )}
    </>
  );
}
