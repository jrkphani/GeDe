import { Button, SegmentedControl, Select, Switch, Tooltip } from '@gede/ui';
import {
  cellRich,
  CHARACTER_STYLE_BUNDLES,
  CHARACTER_STYLE_LABELS,
  CHARACTER_STYLES,
  characterStyleOf,
  FONT_FAMILIES,
  FONT_FAMILY_LABELS,
  FONT_WEIGHT_LABELS,
  FONT_WEIGHTS,
  H_ALIGNS,
  hasMarkThroughout,
  rowMeta,
  tableRecord,
  TEXT_COLOUR_TOKENS,
  TOGGLE_MARKS,
  TYPE_SIZE_PX,
  TYPE_SIZES,
  V_ALIGNS,
  WRAPPED_ROW_HEIGHT,
  type FontWeight,
  type HAlign,
  type TableMap,
  type ToggleMark,
  type VAlign,
} from '@gede/core';

import type { GridCommands } from '../grid/commands.js';
import { markAriaKeys, markLabel } from '../keys/shortcut-map.js';
import type { CellSelection } from '../selection.js';
import { useAppearanceScope } from './appearance-scope.js';
import { Section } from './controls.js';
import { TEXT_COLOUR_LABELS } from './RulesSection.js';

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

const H_LABELS: Readonly<Record<HAlign | 'auto', string>> = {
  auto: 'Auto',
  left: 'Left',
  center: 'Centre',
  right: 'Right',
  justify: 'Justify',
};
const V_LABELS: Readonly<Record<VAlign, string>> = {
  top: 'Top',
  middle: 'Middle',
  bottom: 'Bottom',
};

/**
 * INSP-06: the Text tab. Font family, the four-step weight, size on the
 * type scale, inline marks over the whole cell (KEYS-05, with the chord
 * beside each, KEYS-08), character styles as bundles of the above, text
 * colour, horizontal and vertical alignment, and wrap (GRID-09). Typography,
 * colour and alignment are column-scoped with a cell override (INSP-10);
 * every change is one `GridCommands` call, live on the canvas (INSP-12).
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
  const look = useAppearanceScope(table, record, cell, editable, commands, 'the typography');
  const a = look.effective;
  const activeStyle = characterStyleOf(a);

  return (
    <>
      <Section label="font" hint={look.sentence}>
        <div className="gd-insp__stack">
          {look.control}
          <Select
            label="Family"
            value={a.font ?? 'ui'}
            disabledReason={look.disabledReason}
            onValueChange={(font) => {
              look.write({ font });
            }}
            options={FONT_FAMILIES.map((f) => ({ value: f, label: FONT_FAMILY_LABELS[f] }))}
          />
          <Select
            label="Weight"
            value={String(a.weight ?? 400)}
            disabledReason={look.disabledReason}
            onValueChange={(value) => {
              look.write({ weight: Number(value) as FontWeight });
            }}
            options={FONT_WEIGHTS.map((w) => ({ value: String(w), label: FONT_WEIGHT_LABELS[w] }))}
          />
          <Select
            label="Size"
            hint="type scale"
            value={a.size ?? 'cell'}
            disabledReason={look.disabledReason}
            onValueChange={(size) => {
              look.write({ size });
            }}
            options={TYPE_SIZES.map((size) => ({
              value: size,
              label: `${String(TYPE_SIZE_PX[size])} px · ${size}`,
            }))}
          />
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
      <Section
        label="character styles"
        hint="Title, Heading and Body set size and weight together on the type scale."
      >
        <div className="gd-insp__row" role="group" aria-label="Character styles">
          {CHARACTER_STYLES.map((style) => {
            const label = CHARACTER_STYLE_LABELS[style];
            const bundle = CHARACTER_STYLE_BUNDLES[style];
            const reason = look.disabledReason;
            return (
              <Button
                key={style}
                size="sm"
                variant="secondary"
                className={`gd-insp__preset gd-insp__preset--${style}`}
                aria-pressed={activeStyle === style}
                aria-disabled={reason !== undefined || undefined}
                title={reason === undefined ? `${label} style` : `${label} style — ${reason}`}
                onClick={
                  reason === undefined
                    ? () => {
                        look.write({ size: bundle.size ?? null, weight: bundle.weight ?? null });
                      }
                    : undefined
                }
              >
                {label}
              </Button>
            );
          })}
        </div>
      </Section>
      <Section
        label="text colour"
        hint="Every token clears 4.5:1 on the surface; on a fill the ink adjusts."
      >
        <Select
          label="Text colour"
          value={a.textColour ?? ''}
          placeholder="Inherit"
          clearLabel="Inherit"
          disabledReason={look.disabledReason}
          onValueChange={(textColour) => {
            look.write({ textColour: textColour === '' ? null : textColour });
          }}
          options={TEXT_COLOUR_TOKENS.map((t) => ({
            value: t,
            label: (
              <span className="gd-insp__ink" data-ink={t}>
                <span className="gd-insp__ink-swatch" aria-hidden="true" />
                {TEXT_COLOUR_LABELS[t]}
              </span>
            ),
          }))}
        />
      </Section>
      <Section label="alignment" hint="Auto keeps numbers right and text left (FMT-02).">
        <div className="gd-insp__stack">
          <SegmentedControl
            label="Horizontal alignment"
            value={a.hAlign ?? 'auto'}
            disabled={look.disabledReason !== undefined}
            onChange={(value) => {
              look.write({ hAlign: value === 'auto' ? null : value });
            }}
            options={(['auto', ...H_ALIGNS] as const).map((h) => ({
              value: h,
              label: H_LABELS[h],
            }))}
          />
          <SegmentedControl
            label="Vertical alignment"
            value={a.vAlign ?? 'middle'}
            disabled={look.disabledReason !== undefined}
            onChange={(vAlign) => {
              look.write({ vAlign });
            }}
            options={V_ALIGNS.map((v) => ({ value: v, label: V_LABELS[v] }))}
          />
        </div>
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
