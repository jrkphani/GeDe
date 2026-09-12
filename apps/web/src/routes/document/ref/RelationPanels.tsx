import {
  addMappingColumn,
  clearPull,
  listSheets,
  pullOf,
  setPull,
  tableById,
  tablesOnSheet,
  type GedeDoc,
  type Id,
} from '@gede/core';
import { Select, TextField } from '@gede/ui';

import { ReasonedButton } from '../inspector/controls.js';
import { useState } from 'react';
import type * as Y from 'yjs';

import { announce } from '../../../announce.js';
import { useYVersion } from '../../../doc/use-y.js';

interface RelationPanelProps {
  gd: GedeDoc;
  tableId: Id;
  undo?: Y.UndoManager | null | undefined;
  editable?: boolean | undefined;
}

/** Every table in the workscape but `exceptId`, labelled `Sheet · Table` (any sheet, REF-02). */
function tableOptions(gd: GedeDoc, exceptId: Id) {
  const out: { value: string; label: string }[] = [];
  for (const sheet of listSheets(gd)) {
    for (const table of tablesOnSheet(gd, sheet.id)) {
      if (table.id === exceptId) continue;
      out.push({ value: table.id, label: `${sheet.label} · ${table.title}` });
    }
  }
  return out;
}

function columnOptions(gd: GedeDoc, tableId: Id, { pickable = false } = {}) {
  const record = tableId === '' ? null : tableById(gd, tableId);
  return (record?.columns ?? []).map((c) => ({
    value: c.id,
    label: c.label || 'Untitled column',
    // A mapping picks stored values; a derived column has none (REF-03).
    ...(pickable && c.derive !== null
      ? { disabled: true, description: 'Derived: its values are computed, not stored' }
      : {}),
  }));
}

/**
 * Format — Derive: cross-table relation, pull (REF-02). Binds a receiving
 * column of this table to a column of any table on any sheet, filtered by
 * a contains expression; the receiving column renames itself after its
 * source and the matching rows appear beneath the table's own, live.
 */
export function PullPanel({ gd, tableId, undo, editable = true }: RelationPanelProps) {
  const table = gd.tables.get(tableId) ?? null;
  useYVersion(table);
  useYVersion(gd.tables, { depth: 'shallow' });
  const record = tableById(gd, tableId);
  const current = table === null ? null : pullOf(table);
  const [receiving, setReceiving] = useState<Id>(current?.colId ?? '');
  const [sourceTable, setSourceTable] = useState<Id>(current?.spec.tableId ?? '');
  const [sourceCol, setSourceCol] = useState<Id>(current?.spec.colId ?? '');
  const [filter, setFilter] = useState(current?.spec.filter ?? '');
  const [status, setStatus] = useState<string | null>(null);
  if (record === null) return null;

  const receivingOptions = record.columns
    .filter((c) => c.source === 'entered' || c.source === 'pulled')
    .map((c) => ({ value: c.id, label: c.label || 'Untitled column' }));
  const ready = receiving !== '' && sourceTable !== '' && sourceCol !== '';
  // INSP-11 / #126: every unavailable control says why, in the control itself.
  const viewOnly = editable ? undefined : 'you have view-only access';
  const sourceColumnReason =
    viewOnly ?? (sourceTable === '' ? 'pick a source table first' : undefined);
  const pullReason =
    viewOnly ??
    (receiving === ''
      ? 'pick a receiving column first'
      : sourceTable === ''
        ? 'pick a source table first'
        : sourceCol === ''
          ? 'pick a source column first'
          : undefined);
  const bind = () => {
    if (!editable || !ready) return;
    undo?.stopCapturing();
    const ok = setPull(gd, tableId, receiving, { tableId: sourceTable, colId: sourceCol, filter });
    const text = ok ? 'Rows pulled' : 'That source cannot be pulled';
    setStatus(text);
    announce(text);
  };
  const unbind = () => {
    if (!editable) return;
    undo?.stopCapturing();
    if (clearPull(gd, tableId)) {
      setStatus('Pull removed');
      announce('Pull removed');
    }
  };

  return (
    <section className="gd-derive" aria-label="Pull rows" data-testid="pull-panel">
      <h3 className="gd-derive__title">Pull rows from another table</h3>
      <Select
        label="Receiving column"
        value={receiving}
        onValueChange={setReceiving}
        options={receivingOptions}
        placeholder="Pick a column"
        disabled={!editable}
      />
      <Select
        label="Source table"
        value={sourceTable}
        onValueChange={(v) => {
          setSourceTable(v);
          setSourceCol('');
        }}
        options={tableOptions(gd, tableId)}
        placeholder="Pick a table"
        emptyText="No other table in this workscape yet"
        disabled={!editable}
      />
      <Select
        label="Source column"
        hint={sourceColumnReason}
        value={sourceCol}
        onValueChange={setSourceCol}
        options={columnOptions(gd, sourceTable)}
        placeholder="Pick a column"
        disabledReason={sourceColumnReason}
      />
      <TextField
        label="Only rows containing"
        hint="Leave empty to mirror every row with a value"
        value={filter}
        disabled={!editable}
        onChange={(e) => {
          setFilter(e.currentTarget.value);
        }}
      />
      <div className="gd-derive__actions">
        <ReasonedButton
          variant="primary"
          size="md"
          label={current === null ? 'Pull rows' : 'Update pull'}
          reason={pullReason}
          onClick={bind}
        />
        {current !== null && (
          <ReasonedButton
            variant="ghost"
            size="md"
            label="Remove pull"
            reason={viewOnly}
            onClick={unbind}
          />
        )}
      </div>
      {status !== null && (
        <p className="gd-derive__status" role="status">
          {status}
        </p>
      )}
    </section>
  );
}

/**
 * Format — Derive: cross-table relation, mapping column (REF-03). Adds a
 * column bound to a target column elsewhere; its cells become pickers over
 * the target's distinct values.
 */
export function MappingColumnPanel({ gd, tableId, undo, editable = true }: RelationPanelProps) {
  const table = gd.tables.get(tableId) ?? null;
  useYVersion(table);
  useYVersion(gd.tables, { depth: 'shallow' });
  const record = tableById(gd, tableId);
  const [targetTable, setTargetTable] = useState<Id>('');
  const [targetCol, setTargetCol] = useState<Id>('');
  const [status, setStatus] = useState<string | null>(null);
  if (record === null) return null;
  const ready = targetTable !== '' && targetCol !== '';
  const viewOnly = editable ? undefined : 'you have view-only access';
  const targetColumnReason =
    viewOnly ?? (targetTable === '' ? 'pick a target table first' : undefined);
  const addReason =
    viewOnly ??
    (targetTable === ''
      ? 'pick a target table first'
      : targetCol === ''
        ? 'pick a target column first'
        : undefined);
  const add = () => {
    if (!editable || !ready) return;
    undo?.stopCapturing();
    const id = addMappingColumn(gd, tableId, { tableId: targetTable, colId: targetCol });
    const text = id === null ? 'That target column does not exist' : 'Mapping column added';
    setStatus(text);
    announce(text);
  };
  const existing = record.columns.filter((c) => c.link !== null);
  return (
    <section className="gd-derive" aria-label="Mapping column" data-testid="mapping-panel">
      <h3 className="gd-derive__title">Add a mapping column</h3>
      <Select
        label="Target table"
        value={targetTable}
        onValueChange={(v) => {
          setTargetTable(v);
          setTargetCol('');
        }}
        options={tableOptions(gd, '')}
        placeholder="Pick a table"
        disabled={!editable}
      />
      <Select
        label="Target column"
        hint={targetColumnReason}
        value={targetCol}
        onValueChange={setTargetCol}
        options={columnOptions(gd, targetTable, { pickable: true })}
        placeholder="Pick a column"
        disabledReason={targetColumnReason}
      />
      <div className="gd-derive__actions">
        <ReasonedButton
          variant="primary"
          size="md"
          label="Add mapping column"
          reason={addReason}
          onClick={add}
        />
      </div>
      {status !== null && (
        <p className="gd-derive__status" role="status">
          {status}
        </p>
      )}
      {existing.length > 0 && (
        <ul className="gd-derive__list" aria-label="Mapping columns">
          {existing.map((c) => (
            <li key={c.id} className="gd-derive__item">
              <span className="gd-derive__item-label">{c.label}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
