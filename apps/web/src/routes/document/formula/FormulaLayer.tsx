import { memo, type CSSProperties } from 'react';
import {
  cellsMap,
  dataGeometry,
  cellRefInTable,
  isFormula,
  LATTICE,
  rowMeta,
  splitCellKey,
  tableRecord,
  tablesOnSheet,
  type CellKey,
  type GedeDoc,
  type Id,
  type TableMap,
} from '@gede/core';

import { useYVersion } from '../../../doc/use-y.js';
import type { ZoomTier } from '../../../doc/viewport.js';
import type { CellSelection } from '../selection.js';
import { FormulaCellContent } from './FormulaCellContent.js';
import { ReferenceOutlines, useDraftOperands } from './ReferenceOutlines.js';
import { useCellDisplay } from './use-cell-display.js';

export interface FormulaLayerProps {
  gd: GedeDoc;
  sheetId: Id | null;
  tier: ZoomTier;
  zoom: number;
  /** The armed cell: its operands are outlined while it is a formula (FX-08). */
  selected: CellSelection | null;
  /** The cell whose editor is open: its overlay hides so the editor shows through. */
  editing: CellSelection | null;
  /** The editor's live draft, when the host shares it; outlines follow it as it is typed. */
  draft?: string | null | undefined;
}

/**
 * Mounted once inside `<Canvas>` (after the tables, so it paints above them):
 *
 * 1. Reference outlines for the selected or edited formula cell (FX-08).
 * 2. Interim formula-cell presentation (FX-07): value + badge + expression,
 *    positioned over each formula cell. The grid's own Cell renders this
 *    content once it adopts `useCellDisplay` + `FormulaCellContent`; at that
 *    point `overlays` is switched off and this layer keeps only the outlines.
 */
export function FormulaLayer({
  gd,
  sheetId,
  tier,
  zoom,
  selected,
  editing,
  draft,
}: FormulaLayerProps) {
  useYVersion(gd.tables, { depth: 'shallow' });
  const tables = sheetId === null ? [] : tablesOnSheet(gd, sheetId);
  const focus = editing ?? selected;
  const focusTable = focus === null ? null : (gd.tables.get(focus.tableId) ?? null);
  const stored =
    focusTable === null || focus === null
      ? undefined
      : cellsMap(focusTable).get(`${focus.rowId}:${focus.colId}`);
  const formula =
    draft !== undefined && draft !== null && editing !== null
      ? draft
      : isFormula(stored)
        ? stored
        : null;
  const operands = useDraftOperands(gd, sheetId, formula);
  return (
    <>
      {tier === 'micro' &&
        tables.map((t) => {
          const map = gd.tables.get(t.id);
          if (map === undefined) return null;
          return (
            <FormulaCells
              key={t.id}
              table={map}
              editingKey={
                editing !== null && editing.tableId === t.id
                  ? `${editing.rowId}:${editing.colId}`
                  : null
              }
              selectedKey={
                selected !== null && selected.tableId === t.id
                  ? `${selected.rowId}:${selected.colId}`
                  : null
              }
            />
          );
        })}
      {formula !== null && operands.length > 0 && (
        <ReferenceOutlines operands={operands} zoom={zoom} />
      )}
    </>
  );
}

interface FormulaCellsProps {
  table: TableMap;
  editingKey: string | null;
  selectedKey: string | null;
}

/** Every formula cell of one table, as an overlay at the cell's lattice bounds. */
const FormulaCells = memo(function FormulaCells({
  table,
  editingKey,
  selectedKey,
}: FormulaCellsProps) {
  useYVersion(table);
  const record = tableRecord(table);
  const geometry = dataGeometry(table, record);
  const keys: CellKey[] = [];
  cellsMap(table).forEach((content, key) => {
    if (isFormula(content) && key !== editingKey) keys.push(key as CellKey);
  });
  if (keys.length === 0) return null;
  return (
    <>
      {keys.map((key) => {
        const { rowId, colId } = splitCellKey(key);
        const r = record.rows.indexOf(rowId);
        const c = record.columns.findIndex((col) => col.id === colId);
        if (r < 0 || c < 0) return null;
        const ref = cellRefInTable(geometry, c, r);
        const style: CSSProperties = {
          left: `${String(ref.col * LATTICE.col)}px`,
          top: `${String(ref.row * LATTICE.row)}px`,
          width: `${String((record.columns[c]?.width ?? 1) * LATTICE.col)}px`,
          height: `${String(rowMeta(table, rowId).height * LATTICE.row)}px`,
        };
        return (
          <FormulaCellOverlay
            key={key}
            table={table}
            cellKey={key}
            style={style}
            selected={key === selectedKey}
          />
        );
      })}
    </>
  );
});

function FormulaCellOverlay({
  table,
  cellKey,
  style,
  selected,
}: {
  table: TableMap;
  cellKey: CellKey;
  style: CSSProperties;
  selected: boolean;
}) {
  const display = useCellDisplay(table, cellKey);
  return (
    <div
      className={`gd-formula-overlay${selected ? ' gd-formula-overlay--selected' : ''}`}
      style={style}
      data-testid="formula-overlay"
    >
      <FormulaCellContent display={display} />
    </div>
  );
}
