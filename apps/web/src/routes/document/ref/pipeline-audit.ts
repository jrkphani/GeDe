/**
 * The pipeline audit list (INSP-09, #127): what each derivation step of a
 * table reads, where it sits in the chain, and what it produced last time
 * the engine ran — rows with a value, rows in error, rows still pending.
 * Pure: the engine's results come in through `resultOf`, so the list can be
 * computed and tested without React or a Worker.
 */
import {
  cellKey,
  derivedColumnsOf,
  evaluatedText,
  pullLabel,
  pullOf,
  rowMeta,
  tableRecord,
  workbookCellId,
  type CellResult,
  type DeriveSpec,
  type GedeDoc,
  type Id,
  type TableMap,
  type TableRecord,
} from '@gede/core';

export interface StepOutcome {
  /** Rows the step produced a value for (nothing matched — blank or empty — is not a value). */
  readonly rows: number;
  /** Rows whose evaluation failed (the cell shows the error). */
  readonly errors: number;
  /** Rows the engine has not answered for yet. */
  readonly pending: number;
  /** The newest result version among the step's cells; 0 with no result. Ticks on recompute. */
  readonly version: number;
}

export interface DerivedStep {
  readonly kind: 'derived';
  readonly colId: Id;
  readonly label: string;
  readonly signature: string;
  readonly spec: DeriveSpec;
  /** 1-based position among the table's derived columns. */
  readonly step: number;
  /** What the step reads: a column's label, and the step number when that column is itself derived. */
  readonly source: { readonly label: string; readonly step: number | null };
  readonly outcome: StepOutcome;
}

export interface PullStep {
  readonly kind: 'pull';
  readonly colId: Id;
  readonly label: string;
  /** `↰ Table · Column`, as the receiving column names it (PRD §14). */
  readonly signature: string;
  /** Rows mirrored from the source table. */
  readonly rows: number;
}

export type PipelineStep = DerivedStep | PullStep;

export type ResultReader = (cellId: string) => CellResult | undefined;

function outcomeOf(
  table: TableMap,
  record: TableRecord,
  colId: Id,
  resultOf: ResultReader,
): StepOutcome {
  let rows = 0;
  let errors = 0;
  let pending = 0;
  let version = 0;
  for (const rowId of record.rows) {
    // A category band has no cells of its own (GRID-04).
    if (rowMeta(table, rowId).group) continue;
    const result = resultOf(workbookCellId(record.id, cellKey(rowId, colId)));
    if (result === undefined) {
      pending += 1;
      continue;
    }
    if (result.version > version) version = result.version;
    if (result.error !== null) errors += 1;
    else if (evaluatedText(result.value) !== '') rows += 1;
  }
  return { rows, errors, pending, version };
}

/** The table's derivation chain, source → step 1 → step 2 …, each with its last outcome. */
export function auditPipeline(gd: GedeDoc, tableId: Id, resultOf: ResultReader): PipelineStep[] {
  const table = gd.tables.get(tableId);
  if (table === undefined) return [];
  const record = tableRecord(table);
  const derived = derivedColumnsOf(record);
  const stepOf = new Map<Id, number>();
  derived.forEach((d, i) => stepOf.set(d.column.id, i + 1));
  const steps: PipelineStep[] = derived.map((d, i) => {
    const source = record.columns.find((c) => c.id === d.spec.sourceColId);
    return {
      kind: 'derived',
      colId: d.column.id,
      label: d.column.label,
      signature: d.signature,
      spec: d.spec,
      step: i + 1,
      source: {
        label: source?.label ?? '#REF',
        step: source === undefined ? null : (stepOf.get(source.id) ?? null),
      },
      outcome: outcomeOf(table, record, d.column.id, resultOf),
    };
  });
  const pull = pullOf(table);
  if (pull !== null) {
    const column = record.columns.find((c) => c.id === pull.colId);
    let rows = 0;
    for (const rowId of record.rows) {
      if (rowMeta(table, rowId).pulledFrom !== null) rows += 1;
    }
    steps.push({
      kind: 'pull',
      colId: pull.colId,
      label: column?.label ?? '#REF',
      signature: pullLabel(gd, pull.spec),
      rows,
    });
  }
  return steps;
}
