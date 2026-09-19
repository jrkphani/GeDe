import { SegmentedControl, Select, Switch, TextField } from '@gede/ui';
import {
  cellAddress,
  GRIDLINE_DENSITIES,
  GRIDLINE_LABELS,
  LATTICE,
  OUTLINE_WEIGHTS,
  rowMeta,
  setTableLook,
  TABLE_STYLE_LABELS,
  TABLE_STYLES,
  tableRecord,
  type GedeDoc,
  type Id,
  type OutlineWeight,
  type TableMap,
} from '@gede/core';

import { announce } from '../../../announce.js';
import { frozenOptions } from '../grid/TableMenu.js';
import type { GridCommands } from '../grid/commands.js';
import { HierarchyPanel } from '../hier/HierarchyPanel.js';
import { selectedBand, type Selection } from '../selection.js';
import { fitColumnsToContent, fitRowsToContent, useFitter } from '../style/index.js';
import { ReasonedButton, Section, SizeField, Stepper } from './controls.js';

export interface TableTabProps {
  gd: GedeDoc;
  table: TableMap;
  selection: Selection | null;
  editable: boolean;
  commands: GridCommands;
}

/** The "Outline column" select's value for "no designation: the first visible column" (ADR-051). */
const OUTLINE_DEFAULT = 'first';

const OUTLINE_LABELS: Readonly<Record<OutlineWeight, string>> = {
  none: 'None',
  hairline: 'Hairline',
  strong: 'Strong',
  accent: 'Accent',
};

/**
 * INSP-04: the Table tab. Table style, title and caption, header row, footer,
 * header (frozen) columns, row and column counts that insert or delete
 * structure, outline, gridline density, alternating row colour, width, wrap
 * and fit-to-content — each a `GridCommands` call, live on the canvas
 * (INSP-12). Nothing here moves an address: the style is paint, the caption
 * is a strip at the foot, fit snaps to whole units (GRID-01).
 */
export function TableTab({ gd, table, selection, editable, commands }: TableTabProps) {
  const record = tableRecord(table);
  const viewOnly = editable ? undefined : 'you have view-only access';
  const rows = record.rows.length;
  const columns = record.columns.length;
  const visibleWidth = record.columns.filter((c) => !c.hidden).reduce((a, c) => a + c.width, 0);
  const lastRow = record.rows[rows - 1];
  const lastColumn = record.columns[columns - 1];
  const { look } = record;
  // Fit-to-content measures with canvas `measureText`; where no 2D context exists the
  // buttons say so rather than guessing a width (no invented data).
  const fitter = useFitter(gd.doc);
  const fitReason = viewOnly ?? fitter.reason;
  const fitOptions = fitter.fit;
  // INSP-04 / #167 criterion 8 (Numbers N4): Height and Width act on the selection — the
  // selected rows or columns (a band), else the armed cell's row and column, else the whole
  // table when the table is selected. Mixed sizes read the first member's.
  const rowBand = selectedBand(selection, record.id, 'row');
  const columnBand = selectedBand(selection, record.id, 'column');
  const armed = selection?.tableId === record.id ? (selection.cell ?? null) : null;
  const visibleIds = record.columns.filter((c) => !c.hidden).map((c) => c.id);
  const targetRows: readonly Id[] =
    rowBand?.ids ??
    (armed !== null ? [armed.rowId] : selection?.tableId === record.id ? record.rows : []);
  const targetColumns: readonly Id[] =
    columnBand?.ids ??
    (armed !== null ? [armed.colId] : selection?.tableId === record.id ? visibleIds : []);
  const rowUnits = targetRows.length === 0 ? null : rowMeta(table, targetRows[0] ?? '').height;
  const columnUnits =
    targetColumns.length === 0
      ? null
      : (record.columns.find((c) => c.id === targetColumns[0])?.width ?? null);
  const rowSubject =
    targetRows.length === 1
      ? (() => {
          const first = visibleIds[0];
          const address =
            first === undefined ? null : cellAddress(table, targetRows[0] ?? '', first);
          const n = address?.replace(/^[A-Z]+/, '');
          return n === undefined || n === '' ? 'row' : `row ${n}`;
        })()
      : `${String(targetRows.length)} rows`;
  const columnSubject =
    targetColumns.length === 1
      ? `column ${record.columns.find((c) => c.id === targetColumns[0])?.label ?? ''}`
      : `${String(targetColumns.length)} columns`;

  return (
    <>
      <Section
        label="table style"
        hint="A header band and an alternating band from one ramp (the prototype's swatches)."
      >
        <SegmentedControl
          label="Style"
          className="gd-insp__styles"
          value={look.style}
          disabled={viewOnly !== undefined}
          onChange={(style) => {
            commands.setTableLook(record.id, { style });
          }}
          options={TABLE_STYLES.map((style) => ({
            value: style,
            label: (
              <span className="gd-insp__style-swatch" data-style={style}>
                <span className="gd-insp__style-head" aria-hidden="true" />
                <span className="gd-insp__style-band" aria-hidden="true" />
                {TABLE_STYLE_LABELS[style]}
              </span>
            ),
          }))}
        />
      </Section>
      <Section
        label="title and caption"
        hint="The title bar keeps its two lattice rows; the caption is one row at the foot. No address moves."
      >
        <div className="gd-insp__stack">
          <Switch
            label="Title"
            checked={look.titleShown}
            disabled={!editable}
            onCheckedChange={(on) => {
              commands.setTableLook(record.id, { titleShown: on });
            }}
          />
          <Switch
            label="Caption"
            checked={look.captionShown}
            disabled={!editable}
            onCheckedChange={(on) => {
              commands.setTableLook(record.id, { captionShown: on });
            }}
          />
          {look.captionShown && (
            <TextField
              label="Caption text"
              value={look.caption}
              disabled={!editable}
              placeholder="What this table holds"
              onChange={(e) => {
                // As the title field does (TitleBar): the document is the state, and the
                // keystrokes merge into one undo step through the manager's capture window
                // — a `GridCommands` call would settle (and announce) every character.
                if (editable) setTableLook(gd, record.id, { caption: e.currentTarget.value });
              }}
              onBlur={() => {
                announce(
                  look.caption === ''
                    ? `${record.title}: caption cleared`
                    : `${record.title}: caption is “${look.caption}”`,
                );
              }}
            />
          )}
        </div>
      </Section>
      {/* INSP-04 / GRID-11: header row, header column and footer row *counts* — 0 or 1 for the
          rows (the lattice has one header strip and one footer strip), any count short of every
          column for the frozen columns. This tab is their one home (DOC-02, ADR-041). */}
      <Section label="headers and footer" hint="0 hides the strip, 1 shows it.">
        <div className="gd-insp__stack">
          <Stepper
            label="Header rows"
            unit={record.headerRows === 1 ? 'row' : 'rows'}
            name="header rows"
            value={record.headerRows}
            min={0}
            max={1}
            disabledReason={viewOnly}
            decrementReason="the header row is hidden"
            onChange={(next) => {
              commands.setHeaderRows(record.id, next === 0 ? 0 : 1);
            }}
          />
          <Select
            label="Header columns"
            hint="frozen"
            value={String(record.frozenColumns)}
            disabledReason={viewOnly}
            onValueChange={(value) => {
              commands.setFrozenColumns(record.id, Number(value));
            }}
            options={frozenOptions(columns).map((n) => ({
              value: String(n),
              label: n === 0 ? 'None' : `${String(n)} ${n === 1 ? 'column' : 'columns'}`,
            }))}
          />
          <Stepper
            label="Footer rows"
            unit={record.footerRows === 1 ? 'row' : 'rows'}
            name="footer rows"
            value={record.footerRows}
            min={0}
            max={1}
            disabledReason={viewOnly}
            decrementReason="the footer is hidden"
            onChange={(next) => {
              commands.setFooterRows(record.id, next === 0 ? 0 : 1);
            }}
          />
        </div>
      </Section>
      <Section label="rows and columns" hint="− deletes the last row or column; + appends one.">
        <div className="gd-insp__stack">
          <Stepper
            label="Rows"
            unit="rows"
            value={rows}
            min={1}
            disabledReason={viewOnly}
            decrementReason="a table keeps at least one row"
            onChange={(next) => {
              if (next > rows) commands.insertRowBelow(record.id);
              else if (lastRow !== undefined) commands.deleteRow(record.id, lastRow);
            }}
          />
          <Stepper
            label="Columns"
            unit="columns"
            value={columns}
            min={1}
            disabledReason={viewOnly}
            decrementReason="a table keeps at least one column"
            onChange={(next) => {
              if (next > columns) commands.insertColumnAfter(record.id);
              else if (lastColumn !== undefined) commands.deleteColumn(record.id, lastColumn.id);
            }}
          />
        </div>
      </Section>
      <Section label="outline and gridlines">
        <div className="gd-insp__stack">
          <Select
            label="Table outline"
            value={look.outline}
            disabledReason={viewOnly}
            onValueChange={(outline) => {
              commands.setTableLook(record.id, { outline });
            }}
            options={OUTLINE_WEIGHTS.map((w) => ({ value: w, label: OUTLINE_LABELS[w] }))}
          />
          <Select
            label="Gridline density"
            hint="this table"
            value={look.gridlines}
            disabledReason={viewOnly}
            onValueChange={(gridlines) => {
              commands.setTableLook(record.id, { gridlines });
            }}
            options={GRIDLINE_DENSITIES.map((d) => ({ value: d, label: GRIDLINE_LABELS[d] }))}
          />
          <Switch
            label="Alternating row colour"
            checked={look.alternating}
            disabled={!editable}
            onCheckedChange={(on) => {
              commands.setTableLook(record.id, { alternating: on });
            }}
          />
        </div>
      </Section>
      <Section
        label="row and column size"
        hint="Whole lattice units (22 px rows, 160 px columns at 100 %); addresses never move. Height and Width act on the selected rows and columns, or the whole table."
      >
        <div className="gd-insp__stack">
          <SizeField
            label="Height"
            value={rowUnits}
            unitPx={LATTICE.row}
            subject={rowSubject}
            disabledReason={viewOnly}
            fitReason={fitReason}
            onChange={(units) => {
              commands.setRowHeights(
                record.id,
                targetRows.map((rowId) => ({ rowId, units })),
              );
            }}
            onFit={() => {
              const options = fitOptions();
              if (options !== null)
                commands.fitRows(
                  record.id,
                  fitRowsToContent(table, record, { ...options, only: targetRows }),
                );
            }}
          />
          <SizeField
            label="Width"
            value={columnUnits}
            unitPx={LATTICE.col}
            subject={columnSubject}
            disabledReason={viewOnly}
            fitReason={fitReason}
            onChange={(units) => {
              commands.setColumnWidths(
                record.id,
                targetColumns.map((colId) => ({ colId, units })),
              );
            }}
            onFit={() => {
              const options = fitOptions();
              if (options !== null)
                commands.fitColumns(
                  record.id,
                  fitColumnsToContent(table, record, { ...options, only: targetColumns }),
                );
            }}
          />
          <Stepper
            label="Table width"
            unit="units"
            value={visibleWidth}
            min={Math.max(1, record.columns.filter((c) => !c.hidden).length)}
            disabledReason={viewOnly}
            decrementReason="every visible column is already one unit wide"
            onChange={(next) => {
              commands.scaleTable(record.id, { widthUnits: next });
            }}
          />
          <div className="gd-insp__row">
            {/* Numbers N6 (ADR-049): the selected rows or columns, else every one, share their total. */}
            <ReasonedButton
              label="Distribute rows evenly"
              reason={viewOnly}
              onClick={() => {
                commands.distributeEvenly(record.id, 'row', rowBand?.ids);
              }}
            />
            <ReasonedButton
              label="Distribute columns evenly"
              reason={viewOnly}
              onClick={() => {
                commands.distributeEvenly(record.id, 'column', columnBand?.ids);
              }}
            />
          </div>
        </div>
      </Section>
      <Section
        label="wrap"
        hint="The table's default: a cell, row or column can say otherwise (Text tab). Off, text clips at the cell; on, the row grows to show every line."
      >
        <Switch
          label="Wrap text in cells"
          checked={look.wrap}
          disabled={!editable}
          onCheckedChange={(on) => {
            commands.setTableWrap(record.id, on);
          }}
        />
      </Section>
      {/* HIER-01: the selected row, its parent and depth, promote / nest, collapse. */}
      <Section label="row">
        {/* HIER-04 / ADR-051: the table's default outline column; a row nested from another
            column keeps its own. `first` is the sentinel for "no designation" (Radix refuses ''). */}
        <Select
          label="Outline column"
          hint="default"
          value={record.outlineColumn ?? OUTLINE_DEFAULT}
          disabledReason={viewOnly}
          onValueChange={(value) => {
            commands.setOutlineColumn(record.id, value === OUTLINE_DEFAULT ? null : value);
          }}
          options={[
            { value: OUTLINE_DEFAULT, label: 'First visible column' },
            ...record.columns
              .filter((c) => !c.hidden)
              .map((c) => ({ value: c.id, label: c.label.trim() === '' ? 'Unlabelled' : c.label })),
          ]}
        />
        <HierarchyPanel gd={gd} selection={selection} commands={commands} editable={editable} />
      </Section>
    </>
  );
}
