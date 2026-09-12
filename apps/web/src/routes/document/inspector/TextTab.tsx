import { Button, Select, Switch, Tooltip } from '@gede/ui';
import {
  cellRich,
  hasMarkThroughout,
  rowMeta,
  tableRecord,
  TOGGLE_MARKS,
  WRAPPED_ROW_HEIGHT,
  type TableMap,
  type ToggleMark,
} from '@gede/core';

import type { GridCommands } from '../grid/commands.js';
import { markAriaKeys, markLabel } from '../keys/shortcut-map.js';
import type { CellSelection } from '../selection.js';
import { Section, UnavailableRow } from './controls.js';

export interface TextTabProps {
  table: TableMap;
  cell: CellSelection | null;
  editing: boolean;
  editable: boolean;
  commands: GridCommands;
  /** KEYS-05: toggle a mark over the whole selected cell (the shell owns the write). */
  onToggleMark: (mark: ToggleMark) => void;
}

const MARK_NAMES: Readonly<Record<ToggleMark, string>> = {
  bold: 'Bold',
  italic: 'Italic',
  underline: 'Underline',
  strikethrough: 'Strikethrough',
  superscript: 'Superscript',
  subscript: 'Subscript',
};

const MARK_GLYPHS: Readonly<Record<ToggleMark, string>> = {
  bold: 'B',
  italic: 'I',
  underline: 'U',
  strikethrough: 'S',
  superscript: 'x²',
  subscript: 'x₂',
};

/**
 * INSP-06: the Text tab. Inline marks act on the selected cell as a whole
 * (KEYS-05), with the chord beside each (KEYS-08); wrap is a real column or
 * row command (GRID-09). Font, weight, size, character styles, colour and
 * alignment are not implemented yet and say so (INSP-11).
 */
export function TextTab({ table, cell, editing, editable, commands, onToggleMark }: TextTabProps) {
  const record = tableRecord(table);
  const column = cell === null ? null : (record.columns.find((c) => c.id === cell.colId) ?? null);
  const viewOnly = editable ? undefined : 'you have view-only access';
  const needsCell = cell === null ? 'select a cell first' : undefined;
  const marksReason =
    viewOnly ?? needsCell ?? (editing ? 'finish editing to format the whole cell' : undefined);
  const rich = cell === null ? null : cellRich(table, cell.rowId, cell.colId);
  const rowWrapped = cell !== null && rowMeta(table, cell.rowId).height === WRAPPED_ROW_HEIGHT;

  return (
    <>
      <Section label="font">
        <div className="gd-insp__stack">
          <Select
            label="Family"
            value="ui"
            disabledReason="not implemented in this release"
            onValueChange={() => undefined}
            options={[{ value: 'ui', label: 'System UI' }]}
          />
          <Select
            label="Weight"
            value="regular"
            disabledReason="not implemented in this release"
            onValueChange={() => undefined}
            options={[
              { value: 'thin', label: 'Thin' },
              { value: 'regular', label: 'Regular' },
              { value: 'medium', label: 'Medium' },
              { value: 'bold', label: 'Bold' },
            ]}
          />
          <UnavailableRow labels={['Smaller', 'Larger']} />
        </div>
      </Section>
      <Section
        label="marks"
        hint={marksReason === undefined ? 'Applies to the whole cell.' : undefined}
      >
        <div className="gd-insp__row" role="group" aria-label="Inline marks">
          {TOGGLE_MARKS.map((mark) => {
            const on = rich !== null && hasMarkThroughout(rich, mark);
            const label = MARK_NAMES[mark];
            return (
              <Tooltip
                key={mark}
                content={
                  <span className="gd-doc__tip">
                    {marksReason === undefined ? label : `${label} — ${marksReason}`}
                    {marksReason === undefined && (
                      <kbd className="gd-doc__tip-key">{markLabel(mark)}</kbd>
                    )}
                  </span>
                }
              >
                <Button
                  size="sm"
                  variant="ghost"
                  className={`gd-insp__mark gd-insp__mark--${mark}`}
                  aria-label={label}
                  aria-pressed={on}
                  aria-keyshortcuts={markAriaKeys(mark)}
                  aria-disabled={marksReason !== undefined || undefined}
                  title={
                    marksReason === undefined
                      ? `${label} (${markLabel(mark)})`
                      : `${label} — ${marksReason}`
                  }
                  onClick={
                    marksReason === undefined
                      ? () => {
                          onToggleMark(mark);
                        }
                      : undefined
                  }
                >
                  {MARK_GLYPHS[mark]}
                </Button>
              </Tooltip>
            );
          })}
        </div>
      </Section>
      <Section label="character styles">
        <UnavailableRow labels={['Title', 'Heading', 'Body']} />
      </Section>
      <Section label="text colour">
        <UnavailableRow labels={['Ink', 'Muted', 'Brand', 'Danger']} />
      </Section>
      <Section label="alignment">
        <UnavailableRow labels={['Left', 'Centre', 'Right', 'Justify']} />
        <UnavailableRow labels={['Top', 'Middle', 'Bottom']} />
      </Section>
      <Section label="wrap" hint="Wrapped rows take two lattice units; addresses never move.">
        <div className="gd-insp__stack">
          <Switch
            label={column === null ? 'Wrap column' : `Wrap column ${column.label}`}
            checked={column?.wrap === true}
            disabled={viewOnly !== undefined || column === null}
            onCheckedChange={(on) => {
              if (column !== null) commands.setColumnWrap(record.id, column.id, on);
            }}
          />
          <Switch
            label="Wrap this row"
            checked={rowWrapped}
            disabled={viewOnly !== undefined || cell === null}
            onCheckedChange={(on) => {
              if (cell !== null) commands.setRowWrap(record.id, cell.rowId, on);
            }}
          />
          {(viewOnly ?? needsCell) !== undefined && (
            <p className="gd-insp__reason">Wrap — {viewOnly ?? needsCell}</p>
          )}
        </div>
      </Section>
    </>
  );
}
