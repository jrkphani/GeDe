import {
  addDerivedColumn,
  deleteColumn,
  deriveSignature,
  FORMAT_PRESETS,
  EXTRACT_STYLES,
  METHOD_SIGNATURES,
  setDerivedColumn,
  tableById,
  type DeriveSpec,
  type GedeDoc,
  type Id,
  type MethodName,
} from '@gede/core';
import { Button, Select, TextField } from '@gede/ui';
import { useEffect, useState } from 'react';
import type * as Y from 'yjs';

import { announce } from '../../../announce.js';
import { useYVersion } from '../../../doc/use-y.js';
import { PipelineAudit } from './PipelineAudit.js';

export interface DerivedColumnPanelProps {
  gd: GedeDoc;
  tableId: Id;
  /** Pre-selected source (the selected cell's column). */
  sourceColId?: Id | undefined;
  undo?: Y.UndoManager | null | undefined;
  /** False disables every control (RESP-02, SHARE-03). */
  editable?: boolean | undefined;
}

const METHOD_OPTIONS = METHOD_SIGNATURES.map((m) => ({ value: m.name, label: m.name }));
const PRESET_OPTIONS = FORMAT_PRESETS.map((p) => ({ value: p.label, label: p.label }));
const STYLE_OPTIONS = EXTRACT_STYLES.map((s) => ({ value: s, label: s }));
const NO_STYLE = 'By pattern';

function defaultsFor(method: MethodName): string[] {
  switch (method) {
    case 'Extract':
      return ['country'];
    case 'Split':
      return [', '];
    case 'Replace':
      return ['', ''];
    case 'Format':
      return ['Title Case'];
    case 'Concat':
      return [''];
  }
}

/** The positional text of a spec's arguments, and its `Style=` when Extract carries one. */
function unpack(spec: DeriveSpec): { args: string[]; style: string } {
  const args: string[] = [];
  let style = '';
  for (const a of spec.args) {
    if (typeof a === 'string') args.push(a);
    else if (a.name.toLowerCase() === 'style') style = a.value;
  }
  return { args, style };
}

/**
 * Format — Derive: derived-column composition (REF-04, PRD §18). Composes
 * `@Column.Method(args)` from a source column, a method and its arguments,
 * shows the signature it will carry, creates the column (or, for `Split`,
 * the child rows — HIER-07) and lists the table's pipeline for audit and
 * edit. The inspector mounts this; the panel writes through `@gede/core`.
 */
export function DerivedColumnPanel({
  gd,
  tableId,
  sourceColId,
  undo,
  editable = true,
}: DerivedColumnPanelProps) {
  const table = gd.tables.get(tableId) ?? null;
  useYVersion(table);
  const record = tableById(gd, tableId);
  const [editing, setEditing] = useState<Id | null>(null);
  const [source, setSource] = useState<Id>(sourceColId ?? '');
  // INSP-09 (#127): the compose form follows the selection — a selected cell's
  // column becomes the source — unless a step is being edited.
  useEffect(() => {
    if (sourceColId !== undefined && editing === null) setSource(sourceColId);
  }, [sourceColId, editing]);
  const [method, setMethod] = useState<MethodName>('Extract');
  const [args, setArgs] = useState<string[]>(defaultsFor('Extract'));
  /** Extract only: `Style="…"` instead of a pattern (PRD §3 format-aware extraction). */
  const [style, setStyle] = useState('');
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  if (record === null) return null;

  const sourceOptions = record.columns
    .filter((c) => c.id !== editing)
    .map((c) => ({ value: c.id, label: c.label || 'Untitled column' }));
  const chosenSource = record.columns.some((c) => c.id === source)
    ? source
    : (record.columns[0]?.id ?? '');
  const signature = METHOD_SIGNATURES.find((m) => m.name === method);
  const spec: DeriveSpec = {
    sourceColId: chosenSource,
    method,
    args: method === 'Extract' && style !== '' ? [{ name: 'Style', value: style }] : args,
  };
  const isSplit = method === 'Split';

  const changeMethod = (next: string) => {
    if (next === '') return;
    const name = next as MethodName;
    setMethod(name);
    setArgs(defaultsFor(name));
    setStyle('');
  };
  const setArg = (i: number, value: string) => {
    setArgs((prev) => prev.map((a, j) => (j === i ? value : a)));
  };
  const submit = () => {
    if (!editable) return;
    undo?.stopCapturing();
    if (editing !== null) {
      const ok = setDerivedColumn(gd, tableId, editing, spec);
      setStatus(
        ok
          ? { text: 'Derived column updated', error: false }
          : { text: 'The source column is missing', error: true },
      );
      if (ok) {
        announce('Derived column updated');
        setEditing(null);
      }
      return;
    }
    const id = addDerivedColumn(gd, tableId, spec);
    if (id === null) {
      setStatus({ text: 'Pick a source column first', error: true });
      return;
    }
    const text = isSplit ? 'Split into child rows' : 'Derived column added';
    setStatus({ text, error: false });
    announce(text);
  };
  const edit = (colId: Id, current: DeriveSpec) => {
    setEditing(colId);
    setSource(current.sourceColId);
    setMethod(current.method);
    const unpacked = unpack(current);
    setArgs(unpacked.args.length > 0 ? unpacked.args : defaultsFor(current.method));
    setStyle(unpacked.style);
    setStatus(null);
  };
  const remove = (colId: Id) => {
    if (!editable) return;
    undo?.stopCapturing();
    deleteColumn(gd, tableId, colId);
    if (editing === colId) setEditing(null);
    announce('Derived column removed');
  };

  return (
    <section className="gd-derive" aria-label="Derived column" data-testid="derived-column-panel">
      <h3 className="gd-derive__title">
        {editing === null ? 'Derive a column' : 'Edit derived column'}
      </h3>
      <Select
        label="Source column"
        value={chosenSource}
        onValueChange={setSource}
        options={sourceOptions}
        disabled={!editable}
      />
      <Select
        label="Method"
        value={method}
        onValueChange={changeMethod}
        options={METHOD_OPTIONS}
        disabled={!editable}
      />
      {signature !== undefined && <p className="gd-derive__hint">{signature.hint}</p>}
      {method === 'Extract' && (
        <Select
          label="Extract by"
          value={style === '' ? NO_STYLE : style}
          onValueChange={(v) => {
            setStyle(v === NO_STYLE ? '' : v);
          }}
          options={[{ value: NO_STYLE, label: NO_STYLE }, ...STYLE_OPTIONS]}
          disabled={!editable}
        />
      )}
      {signature?.args.map((arg, i) =>
        method === 'Extract' && style !== '' ? null : method === 'Format' ? (
          <Select
            key={arg.label}
            label={arg.label}
            value={args[i] ?? ''}
            onValueChange={(v) => {
              setArg(i, v);
            }}
            options={PRESET_OPTIONS}
            disabled={!editable}
          />
        ) : (
          <TextField
            key={arg.label}
            label={arg.label}
            value={args[i] ?? ''}
            placeholder={arg.placeholder}
            disabled={!editable}
            onChange={(e) => {
              setArg(i, e.currentTarget.value);
            }}
          />
        ),
      )}
      <p className="gd-derive__hint">Signature</p>
      <code className="gd-derive__signature" data-testid="derive-signature">
        {deriveSignature(record, spec)}
      </code>
      <div className="gd-derive__actions">
        <Button variant="primary" onClick={submit} disabled={!editable || chosenSource === ''}>
          {editing !== null
            ? 'Update derived column'
            : isSplit
              ? 'Split into child rows'
              : 'Create derived column'}
        </Button>
        {editing !== null && (
          <Button
            variant="ghost"
            onClick={() => {
              setEditing(null);
              setStatus(null);
            }}
          >
            Cancel
          </Button>
        )}
      </div>
      {status !== null && (
        <p
          className={`gd-derive__status${status.error ? ' gd-derive__status--error' : ''}`}
          role="status"
        >
          {status.text}
        </p>
      )}
      <PipelineAudit
        gd={gd}
        tableId={tableId}
        selectedColId={sourceColId}
        editable={editable}
        onEdit={edit}
        onRemove={remove}
      />
    </section>
  );
}
