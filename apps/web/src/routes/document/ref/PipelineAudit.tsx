/**
 * The pipeline audit list (INSP-09, #127): for the selected table, each
 * derivation step in chain order — what it reads (a source column, or an
 * earlier step), what it produced when the engine last ran (rows, errors,
 * pending) and when — with Edit and Remove. The step of the selected
 * column is marked current, so selecting a derived cell shows its step.
 *
 * Results come from the engine host (`doc/engine.ts`): the list re-reads
 * after every result batch and after every document change to the table.
 */
import { clearPull, type DeriveSpec, type GedeDoc, type Id } from '@gede/core';
import { Button } from '@gede/ui';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { announce } from '../../../announce.js';
import { engineFor, peekEngine } from '../../../doc/engine.js';
import { useYVersion } from '../../../doc/use-y.js';
import { formatNumber } from '../../../intl.js';
import { useLocale } from '../../../locale.js';
import { auditPipeline, type DerivedStep, type PipelineStep } from './pipeline-audit.js';

export interface PipelineAuditProps {
  gd: GedeDoc;
  tableId: Id;
  /** The selected cell's column: its step is marked current. */
  selectedColId?: Id | undefined;
  editable: boolean;
  onEdit: (colId: Id, spec: DeriveSpec) => void;
  onRemove: (colId: Id) => void;
}

/** The engine's result version for the document: ticks after every batch. */
function useEngineVersion(gd: GedeDoc): number {
  const doc = gd.doc;
  useEffect(() => {
    engineFor(doc);
  }, [doc]);
  const subscribe = useCallback(
    (onChange: () => void) => engineFor(doc).subscribeAll(onChange),
    [doc],
  );
  return useSyncExternalStore(
    subscribe,
    () => peekEngine(doc)?.version ?? 0,
    () => 0,
  );
}

/** "Recomputed 14:05:09" in the active locale; '' before the first result. */
function recomputedAt(locale: string, at: number | undefined): string {
  if (at === undefined) return '';
  return new Intl.DateTimeFormat(locale, { timeStyle: 'medium' }).format(new Date(at));
}

export function PipelineAudit({
  gd,
  tableId,
  selectedColId,
  editable,
  onEdit,
  onRemove,
}: PipelineAuditProps) {
  const [locale] = useLocale();
  const table = gd.tables.get(tableId) ?? null;
  const tableVersion = useYVersion(table);
  const engineVersion = useEngineVersion(gd);
  const host = peekEngine(gd.doc);
  // One walk of the table's rows per change of the table or of the engine's results —
  // not per render: with a thousand rows and a few steps the walk is thousands of lookups.
  // The last recompute is the engine host's own time for the step's newest result — never a
  // time this list made up on seeing it.
  const steps = useMemo(
    () =>
      auditPipeline(
        gd,
        tableId,
        (id) => host?.result(id),
        (id) => host?.computedAt(id),
      ),
    // `tableVersion` and `engineVersion` are what the walk reads; they are the cache key.
    [gd, tableId, host, tableVersion, engineVersion],
  );
  if (steps.length === 0) return null;

  const n = (value: number) => formatNumber(locale, value);
  const outcomeText = (step: DerivedStep): string => {
    const { rows, errors, pending } = step.outcome;
    const parts = [`${n(rows)} ${rows === 1 ? 'row' : 'rows'}`];
    if (errors > 0) parts.push(`${n(errors)} ${errors === 1 ? 'error' : 'errors'}`);
    if (pending > 0) parts.push(`${n(pending)} pending`);
    return parts.join(' · ');
  };
  const readsText = (step: DerivedStep): string =>
    step.source.step === null
      ? `from ${step.source.label || 'Untitled column'}`
      : `from step ${n(step.source.step)} (${step.source.label})`;

  const describe = (step: PipelineStep) =>
    step.kind === 'derived' ? step.signature : `${step.label} ${step.signature}`;

  return (
    <>
      <h3 className="gd-derive__title">Pipeline</h3>
      <ol className="gd-derive__list gd-derive__audit" aria-label="Derived pipeline">
        {steps.map((step) => {
          const current = step.colId === selectedColId;
          const stamp = step.kind === 'derived' ? step.outcome.at : undefined;
          return (
            <li
              key={step.colId}
              className="gd-derive__item gd-derive__step"
              aria-current={current ? 'true' : undefined}
              data-testid="pipeline-step"
            >
              <span className="gd-derive__step-head">
                <span className="gd-derive__step-index">
                  {step.kind === 'derived' ? `Step ${n(step.step)}` : 'Pull'}
                </span>
                <span className="gd-derive__item-label" title={step.signature}>
                  {step.signature}
                </span>
              </span>
              <span className="gd-derive__step-facts">
                {step.kind === 'derived' ? (
                  <>
                    <span>{readsText(step)}</span>
                    <span>{outcomeText(step)}</span>
                    {stamp !== undefined && (
                      <span>
                        recomputed{' '}
                        <time dateTime={new Date(stamp).toISOString()}>
                          {recomputedAt(locale, stamp)}
                        </time>
                      </span>
                    )}
                  </>
                ) : (
                  <span>{`${n(step.rows)} ${step.rows === 1 ? 'row' : 'rows'} pulled`}</span>
                )}
              </span>
              <span className="gd-derive__actions">
                {step.kind === 'derived' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!editable}
                    onClick={() => {
                      onEdit(step.colId, step.spec);
                    }}
                    aria-label={`Edit ${step.signature}`}
                  >
                    Edit
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!editable}
                  onClick={() => {
                    if (step.kind === 'derived') {
                      onRemove(step.colId);
                    } else {
                      clearPull(gd, tableId);
                      announce('Pulled rows removed');
                    }
                  }}
                  aria-label={`Remove ${describe(step)}`}
                >
                  Remove
                </Button>
              </span>
            </li>
          );
        })}
      </ol>
    </>
  );
}
