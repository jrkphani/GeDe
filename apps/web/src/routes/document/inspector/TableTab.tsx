import { useMemo } from 'react';
import { SegmentedControl, Select, Switch, TextField } from '@gede/ui';
import {
  GRIDLINE_DENSITIES,
  GRIDLINE_LABELS,
  OUTLINE_WEIGHTS,
  rowHeights,
  setTableLook,
  TABLE_STYLE_LABELS,
  TABLE_STYLES,
  tableRecord,
  WRAPPED_ROW_HEIGHT,
  type GedeDoc,
  type OutlineWeight,
  type TableMap,
} from '@gede/core';

import { announce } from '../../../announce.js';
import { peekEngine } from '../../../doc/engine.js';
import { useLocale } from '../../../locale.js';
import { toFormatLocale } from '../cell/index.js';
import { frozenOptions } from '../grid/TableMenu.js';
import type { GridCommands } from '../grid/commands.js';
import { HierarchyPanel } from '../hier/HierarchyPanel.js';
import type { Selection } from '../selection.js';
import { canvasMeasure, fitColumnsToContent, fitRowsToContent } from '../style/index.js';
import { ReasonedButton, Section, Stepper } from './controls.js';

export interface TableTabProps {
  gd: GedeDoc;
  table: TableMap;
  selection: Selection | null;
  editable: boolean;
  commands: GridCommands;
}

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
  const [activeLocale] = useLocale();
  const viewOnly = editable ? undefined : 'you have view-only access';
  const rows = record.rows.length;
  const columns = record.columns.length;
  const visibleWidth = record.columns.filter((c) => !c.hidden).reduce((a, c) => a + c.width, 0);
  // GRID-09 / #128: the switch reads what the rows are — every drawn row at two units, whether
  // from its own height or from a wrapping column — so its state answers the click that set it.
  const drawn = rowHeights(table, record).filter((h) => h > 0);
  const wrapped = drawn.length > 0 && drawn.every((h) => h === WRAPPED_ROW_HEIGHT);
  const lastRow = record.rows[rows - 1];
  const lastColumn = record.columns[columns - 1];
  const { look } = record;
  // Fit-to-content measures with canvas `measureText`; where no 2D context exists the
  // buttons say so rather than guessing a width (no invented data).
  const measure = useMemo(() => (typeof document === 'undefined' ? null : canvasMeasure()), []);
  const fitReason =
    viewOnly ?? (measure === null ? 'text cannot be measured in this browser' : undefined);
  const fitOptions = () => {
    if (measure === null) return null;
    const engine = peekEngine(gd.doc);
    return {
      locale: toFormatLocale(activeLocale),
      measure,
      cellValue: (cellId: string) => engine?.result(cellId)?.value ?? undefined,
    };
  };

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
            unit="rows"
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
            unit="rows"
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
        hint="Sizes are whole lattice units; addresses never move."
      >
        <div className="gd-insp__stack">
          <Stepper
            label="Width"
            unit="units"
            value={visibleWidth}
            min={Math.max(1, record.columns.filter((c) => !c.hidden).length)}
            disabledReason={viewOnly}
            decrementReason="every visible column is already one unit wide"
            onChange={(next) => {
              commands.scaleTable(record.id, { widthUnits: next });
            }}
          />
          <Switch
            label="Wrap every row"
            checked={wrapped}
            disabled={!editable}
            onCheckedChange={(on) => {
              commands.setTableWrapped(record.id, on);
            }}
          />
          <div className="gd-insp__row">
            <ReasonedButton
              label="Fit rows to content"
              reason={fitReason}
              onClick={() => {
                const options = fitOptions();
                if (options !== null)
                  commands.fitRows(record.id, fitRowsToContent(table, record, options));
              }}
            />
            <ReasonedButton
              label="Fit columns to content"
              reason={fitReason}
              onClick={() => {
                const options = fitOptions();
                if (options !== null)
                  commands.fitColumns(record.id, fitColumnsToContent(table, record, options));
              }}
            />
          </div>
        </div>
      </Section>
      {/* HIER-01: the selected row, its parent and depth, promote / nest, collapse. */}
      <Section label="row">
        <HierarchyPanel gd={gd} selection={selection} commands={commands} editable={editable} />
      </Section>
    </>
  );
}
