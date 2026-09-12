import { Select, Switch } from '@gede/ui';
import { tableRecord, tableWraps, type GedeDoc, type TableMap } from '@gede/core';

import { frozenOptions } from '../grid/TableMenu.js';
import type { GridCommands } from '../grid/commands.js';
import { HierarchyPanel } from '../hier/HierarchyPanel.js';
import type { Selection } from '../selection.js';
import { Section, Stepper, TRACKED, Unavailable } from './controls.js';

export interface TableTabProps {
  gd: GedeDoc;
  table: TableMap;
  selection: Selection | null;
  editable: boolean;
  commands: GridCommands;
}

/**
 * INSP-04: the Table tab. Header row, footer, header (frozen) columns, row
 * and column counts that insert or delete structure, width and wrap — each
 * a `GridCommands` call, live on the canvas (INSP-12). Table styles, title
 * and caption visibility, outline, gridline density, alternating colour and
 * fit-to-content are not implemented yet and say so (INSP-11).
 */
export function TableTab({ gd, table, selection, editable, commands }: TableTabProps) {
  const record = tableRecord(table);
  const viewOnly = editable ? undefined : 'you have view-only access';
  const rows = record.rows.length;
  const columns = record.columns.length;
  const visibleWidth = record.columns.filter((c) => !c.hidden).reduce((a, c) => a + c.width, 0);
  const wrapped = tableWraps(record);
  const lastRow = record.rows[rows - 1];
  const lastColumn = record.columns[columns - 1];

  return (
    <>
      <Section label="table style">
        <Select
          label="Style"
          value="plain"
          disabledReason={TRACKED.tableAppearance}
          onValueChange={() => undefined}
          options={[{ value: 'plain', label: 'Plain' }]}
        />
      </Section>
      <Section label="title and caption">
        <div className="gd-insp__stack">
          <Switch label="Title" checked disabled onCheckedChange={() => undefined} />
          <p className="gd-insp__reason">
            Title — always shown; hiding it {TRACKED.tableAppearance}
          </p>
          <Switch label="Caption" checked={false} disabled onCheckedChange={() => undefined} />
          <p className="gd-insp__reason">Caption — {TRACKED.tableAppearance}</p>
        </div>
      </Section>
      <Section label="headers and footer">
        <div className="gd-insp__stack">
          <Switch
            label="Header row"
            checked={record.headerRows === 1}
            disabled={!editable}
            onCheckedChange={(on) => {
              commands.setHeaderRows(record.id, on ? 1 : 0);
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
          <Switch
            label="Footer row"
            checked={record.footerRows === 1}
            disabled={!editable}
            onCheckedChange={(on) => {
              commands.setFooterRows(record.id, on ? 1 : 0);
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
            value="none"
            disabledReason={TRACKED.tableAppearance}
            onValueChange={() => undefined}
            options={[
              { value: 'none', label: 'None' },
              { value: 'hairline', label: 'Hairline' },
              { value: 'strong', label: 'Strong' },
              { value: 'accent', label: 'Accent' },
            ]}
          />
          <Select
            label="Gridline density"
            value="light"
            disabledReason={TRACKED.tableAppearance}
            onValueChange={() => undefined}
            options={[
              { value: 'none', label: 'None' },
              { value: 'light', label: 'Light' },
              { value: 'high', label: 'High contrast' },
            ]}
          />
          <Switch
            label="Alternating row colour"
            checked={false}
            disabled
            onCheckedChange={() => undefined}
          />
          <p className="gd-insp__reason">Alternating row colour — {TRACKED.tableAppearance}</p>
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
              commands.scaleTable(record.id, { wrapped: on });
            }}
          />
          <div className="gd-insp__row">
            <Unavailable label="Fit rows to content" reason={TRACKED.tableAppearance} />
            <Unavailable label="Fit columns to content" reason={TRACKED.tableAppearance} />
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
