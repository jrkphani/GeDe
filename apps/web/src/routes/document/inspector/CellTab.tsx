import { useState } from 'react';
import { SegmentedControl, Select, Switch } from '@gede/ui';
import {
  BORDER_EDGE_LABELS,
  BORDER_EDGES,
  BORDER_WEIGHTS,
  cellAddress,
  cellFormatOverride,
  columnFormat,
  countOverrides,
  CURRENCY_CODES,
  DATE_PATTERNS,
  DEFAULT_CURRENCY,
  DEFAULT_DATE_PATTERN,
  describeScope,
  FORMAT_KINDS,
  FORMAT_LABELS,
  MAX_DECIMALS,
  MIN_DECIMALS,
  setCellFormat,
  setColumnFormat,
  tableRecord,
  type BorderEdges,
  type BorderWeight,
  type CellFormat,
  type CurrencyCode,
  type DatePattern,
  type FormatKind,
  type FormatOpts,
  type GedeDoc,
  type HighlightToken,
  type TableMap,
  type TextPreset,
} from '@gede/core';

import { announce } from '../../../announce.js';
import { useMessages, type MessageKey } from '../../../i18n/index.js';
import type { GridCommands } from '../grid/commands.js';
import type { CellSelection } from '../selection.js';
import { useAppearanceScope } from './appearance-scope.js';
import { ReasonedButton, Section } from './controls.js';
import { FormulaSection } from './FormulaSection.js';
import { MergeSection } from './MergeSection.js';
import { RulesSection } from './RulesSection.js';

export interface CellTabProps {
  gd: GedeDoc;
  table: TableMap;
  /** The selected cell in this table, or null when the table itself is selected. */
  cell: CellSelection | null;
  editable: boolean;
  commands: GridCommands;
  /** SET-18: why the table cannot be edited when its section or sheet is locked, else view-only. */
  readOnlyReason?: string | undefined;
}

const FILLS: readonly { value: HighlightToken | 'none'; label: MessageKey }[] = [
  { value: 'none', label: 'inspector.none' },
  { value: 'amber', label: 'inspector.amber' },
  { value: 'forest', label: 'inspector.forest' },
  { value: 'slate', label: 'inspector.slate' },
];

const WEIGHT_LABELS: Readonly<Record<BorderWeight, MessageKey>> = {
  hairline: 'inspector.hairline',
  strong: 'inspector.strong',
  accent: 'inspector.accent',
};

/** The matrix's glyphs (prototype `borderCells`), decorative beside each label. */
const EDGE_GLYPHS: Readonly<Record<BorderEdges, string>> = {
  all: '⊞',
  top: '▔',
  right: '▕',
  bottom: '▁',
  left: '▏',
  outline: '▢',
  'top-bottom': '═',
  'left-right': '║',
  none: '×',
};

type Scope = 'column' | 'cell';

const TEXT_CASES: readonly { value: TextPreset | 'none'; label: MessageKey }[] = [
  { value: 'none', label: 'inspector.asTyped' },
  { value: 'titleCase', label: 'inspector.titleCase' },
  { value: 'upper', label: 'inspector.uppercase' },
  { value: 'lower', label: 'inspector.lowercase' },
  { value: 'trimmed', label: 'inspector.trimmed' },
];

/**
 * INSP-05, INSP-10, FMT-06: data format with its options, fill, the
 * positional border matrix with its weight, conditional highlighting rules
 * and the merge controls (MENU-04). Format and appearance are scoped to the
 * column by default with a cell override; the sentence above each control
 * states the scope before anything is applied; every change writes at once
 * (INSP-12), one undo step each.
 */
export function CellTab({ gd, table, cell, editable, commands, readOnlyReason }: CellTabProps) {
  const t = useMessages();
  const record = tableRecord(table);
  const [scope, setScope] = useState<Scope>('column');
  const look = useAppearanceScope(
    table,
    record,
    cell,
    editable,
    commands,
    'the fill and border',
    readOnlyReason,
  );
  const column = cell === null ? null : (record.columns.find((c) => c.id === cell.colId) ?? null);
  const viewOnly = editable ? undefined : (readOnlyReason ?? 'you have view-only access');
  const needsCell = column === null ? 'select a cell first' : undefined;
  const disabledReason = viewOnly ?? needsCell;
  const override = cell === null ? null : cellFormatOverride(table, cell.rowId, cell.colId);
  const cellOnly = scope === 'cell';
  // Column scope shows and writes the column's format; cell scope the cell's own (else inherited).
  const effective: CellFormat =
    column === null
      ? { kind: 'auto', opts: {} }
      : cellOnly
        ? (override ?? columnFormat(column))
        : columnFormat(column);
  const address = cell === null ? null : cellAddress(table, cell.rowId, cell.colId);
  const overrides = column === null ? 0 : countOverrides(table, column.id);

  const scopeSentence = (to: FormatKind, currency?: CurrencyCode): string | null => {
    if (column === null) return null;
    return describeScope({
      columnLabel: column.label,
      rowCount: record.rows.length,
      overrides: cellOnly ? 0 : overrides,
      to,
      ...(currency === undefined ? {} : { currency }),
      ...(cellOnly ? { cellOnly: true, ...(address === null ? {} : { address }) } : {}),
    });
  };

  const apply = (kind: FormatKind, opts: FormatOpts) => {
    if (column === null || cell === null || !editable) return;
    if (cellOnly) setCellFormat(gd, record.id, cell.rowId, cell.colId, kind, opts);
    else setColumnFormat(gd, record.id, column.id, kind, opts);
    announce(scopeSentence(kind, opts.currency) ?? 'Format applied');
  };
  const setKind = (kind: FormatKind) => {
    const opts: FormatOpts = { ...effective.opts };
    apply(kind, kind === 'currency' ? { currency: DEFAULT_CURRENCY, ...opts } : opts);
  };
  const setOpts = (patch: FormatOpts) => {
    apply(effective.kind, { ...effective.opts, ...patch });
  };

  const decimalOptions = [
    { value: 'auto', label: t('inspector.asTyped') },
    ...Array.from({ length: MAX_DECIMALS - MIN_DECIMALS + 1 }, (_v, i) => ({
      value: String(i + MIN_DECIMALS),
      label: String(i + MIN_DECIMALS),
    })),
  ];
  const currency = effective.opts.currency ?? DEFAULT_CURRENCY;
  const hint =
    column === null
      ? 'Select a cell to set its column format.'
      : scopeSentence(effective.kind, effective.kind === 'currency' ? currency : undefined);

  return (
    <>
      <Section label={t('inspector.dataFormat')} hint={hint}>
        <div className="gd-insp__stack">
          <SegmentedControl
            label={t('inspector.scope')}
            value={scope}
            onChange={setScope}
            disabled={disabledReason !== undefined}
            options={[
              {
                value: 'column',
                label:
                  column === null
                    ? t('inspector.column')
                    : t('inspector.columnLabel', { label: column.label }),
              },
              {
                value: 'cell',
                label:
                  address === null ? t('inspector.cell') : t('inspector.cellAddress', { address }),
              },
            ]}
          />
          <Select
            label={t('inspector.format')}
            hint={cellOnly ? 'this cell' : 'whole column'}
            value={effective.kind}
            disabledReason={disabledReason}
            onValueChange={setKind}
            options={FORMAT_KINDS.map((kind) => ({ value: kind, label: FORMAT_LABELS[kind] }))}
          />
          {(effective.kind === 'number' || effective.kind === 'currency') && (
            <>
              <Select
                label={t('inspector.decimals')}
                value={
                  effective.opts.decimals === undefined ? 'auto' : String(effective.opts.decimals)
                }
                disabledReason={disabledReason}
                onValueChange={(value) => {
                  const { decimals: _dropped, ...rest } = effective.opts;
                  apply(
                    effective.kind,
                    value === 'auto' ? rest : { ...rest, decimals: Number(value) },
                  );
                }}
                options={decimalOptions}
              />
              <Switch
                label={t('inspector.groupThousands')}
                checked={effective.opts.grouping !== false}
                disabled={disabledReason !== undefined}
                onCheckedChange={(on) => {
                  setOpts({ grouping: on });
                }}
              />
            </>
          )}
          {effective.kind === 'currency' && (
            <Select
              label={t('inspector.currency')}
              value={currency}
              disabledReason={disabledReason}
              onValueChange={(value) => {
                setOpts({ currency: value });
              }}
              options={CURRENCY_CODES.map((code) => ({ value: code, label: code }))}
            />
          )}
          {effective.kind === 'date' && (
            <Select
              label={t('inspector.datePattern')}
              value={effective.opts.datePattern ?? DEFAULT_DATE_PATTERN}
              disabledReason={disabledReason}
              onValueChange={(value: DatePattern) => {
                setOpts({ datePattern: value });
              }}
              options={DATE_PATTERNS.map((pattern) => ({ value: pattern, label: pattern }))}
            />
          )}
          {effective.kind === 'text' && (
            <Select
              label={t('inspector.textCase')}
              value={effective.opts.textCase ?? 'none'}
              disabledReason={disabledReason}
              onValueChange={(value) => {
                const { textCase: _dropped, ...rest } = effective.opts;
                apply('text', value === 'none' ? rest : { ...rest, textCase: value });
              }}
              options={TEXT_CASES.map((c) => ({ value: c.value, label: t(c.label) }))}
            />
          )}
          {override !== null && cell !== null && (
            <ReasonedButton
              label={t('inspector.useColumnFormat')}
              available={t('inspector.dropThisCellS')}
              reason={viewOnly}
              onClick={() => {
                setCellFormat(gd, record.id, cell.rowId, cell.colId, null);
                announce(`${address ?? 'The cell'} follows the column format again`);
              }}
            />
          )}
        </div>
      </Section>
      {/* FX-07 / FX-08: the formula behind the cell (filled from the formula release). */}
      {cell !== null && <FormulaSection table={table} cell={cell} />}
      <Section label={t('inspector.fillAndBorder')} hint={look.sentence}>
        <div className="gd-insp__stack">
          {look.control}
          <SegmentedControl
            label={t('inspector.fill')}
            className="gd-insp__fills"
            value={look.effective.fill ?? 'none'}
            disabled={look.disabledReason !== undefined}
            onChange={(fill) => {
              // INSP-10: at cell scope "None" over a column fill is an explicit `none` — the cell
              // shows no fill; at column scope (or with no column fill) it clears back to inherit.
              const columnFill = look.column?.appearance.fill;
              const explicit = look.scope === 'cell' && columnFill !== undefined;
              look.write({ fill: fill === 'none' ? (explicit ? 'none' : null) : fill });
            }}
            options={FILLS.map((f) => ({
              value: f.value,
              label: (
                <span className="gd-insp__fill" data-fill={f.value}>
                  <span className="gd-insp__fill-swatch" aria-hidden="true" />
                  {t(f.label)}
                </span>
              ),
            }))}
          />
          <SegmentedControl
            label={t('inspector.borderEdges')}
            className="gd-insp__matrix"
            value={look.effective.border?.edges ?? 'none'}
            disabled={look.disabledReason !== undefined}
            onChange={(edges) => {
              const weight = look.effective.border?.weight ?? 'hairline';
              const columnBorder = look.column?.appearance.border;
              const explicit = look.scope === 'cell' && columnBorder !== undefined;
              look.write({
                border:
                  edges === 'none' ? (explicit ? { edges, weight } : null) : { edges, weight },
              });
            }}
            options={BORDER_EDGES.map((edges) => ({
              value: edges,
              label: (
                <span className="gd-insp__edge" title={BORDER_EDGE_LABELS[edges]}>
                  <span className="gd-insp__edge-glyph" aria-hidden="true">
                    {EDGE_GLYPHS[edges]}
                  </span>
                  <span className="gd-insp__edge-label">{BORDER_EDGE_LABELS[edges]}</span>
                </span>
              ),
            }))}
          />
          <Select
            label={t('inspector.weight')}
            value={look.effective.border?.weight ?? 'hairline'}
            disabledReason={
              look.disabledReason ??
              (look.effective.border === undefined || look.effective.border.edges === 'none'
                ? 'pick an edge first'
                : undefined)
            }
            onValueChange={(weight) => {
              const border = look.effective.border;
              if (border !== undefined) look.write({ border: { edges: border.edges, weight } });
            }}
            options={BORDER_WEIGHTS.map((w) => ({ value: w, label: t(WEIGHT_LABELS[w]) }))}
          />
          {look.scope === 'cell' && look.override !== null && (
            <ReasonedButton
              label={t('inspector.useColumnAppearance')}
              available={t('inspector.dropThisCellS2')}
              reason={viewOnly}
              onClick={() => {
                look.clearOverride();
              }}
            />
          )}
        </div>
      </Section>
      <RulesSection
        tableId={record.id}
        column={column}
        disabledReason={disabledReason}
        commands={commands}
      />
      <MergeSection table={table} cell={cell} disabledReason={disabledReason} commands={commands} />
    </>
  );
}
