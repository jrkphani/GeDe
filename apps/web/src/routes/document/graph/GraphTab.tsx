import {
  columnLetter,
  coverageMatrix,
  graphById,
  graphsInPair,
  GRAPH_MIN_HEIGHT_UNITS,
  GRAPH_MIN_WIDTH_UNITS,
  resolveSlice,
  withAxis,
  withoutPin,
  withPin,
  type GedeDoc,
  type Id,
} from '@gede/core';
import { Button, Checkbox, Select, Switch } from '@gede/ui';

import { useEffect, useRef } from 'react';

import { ARIA_KEYS, LABELS } from '../../../doc/shortcuts.js';
import { useYVersion } from '../../../doc/use-y.js';
import { formatNumber } from '../../../intl.js';
import { activeLocale } from '../../../locale.js';
import { readOnlyLabel } from '../grid/commands.js';
import { useTourGraphSubstep } from '../../tour/use-tour.js';
import { Section, Stepper } from '../inspector/controls.js';
import type { CellSelection } from '../selection.js';
import { useGraphModel } from './use-graph-model.js';
import type { Graphs } from './use-graphs.js';

/**
 * The Pin select's value for "no explicit pin" — a parameter value can be any
 * text, so the sentinel is a control character no typed value carries.
 */
const FOLLOW_SELECTION = '\u0000follow-selection';

export interface GraphTabProps {
  gd: GedeDoc;
  graphId: Id;
  graphs: Graphs;
  selectedCell: CellSelection | null;
  editable: boolean;
}

/**
 * INSP-08 / GRAPH-05: the Graph tab. Source with Re-point (and a shaped
 * table, GRAPH-04); the eligible-column checklist with distinct counts (REF-05
 * keeps derived, linked and pulled columns out, and says so); Add dimension
 * column; the coverage axes and pins (GRAPH-08); context counts; geometry;
 * Arrange (collapse or expand this half, ADR-047); Delete — this half, the
 * other half, or the pair. Every control writes at once (INSP-12). This tab
 * is the home of collapse and delete (DOC-02, ADR-041); the header chevron,
 * the context menu and the chords are routes to it.
 */
export function GraphTab({ gd, graphId, graphs, selectedCell, editable }: GraphTabProps) {
  // The tab reads the graph's shared keys (dimensions, slice) and the table's columns live.
  useYVersion(gd.graphs);
  useYVersion(gd.tables, { depth: 'shallow' });
  const graph = graphById(gd, graphId);
  if (graph === null) {
    return (
      <Section label="graph">
        <p className="gd-insp__hint">The graph is gone.</p>
      </Section>
    );
  }
  return (
    <GraphTabBody
      gd={gd}
      graph={graph}
      graphs={graphs}
      selectedCell={selectedCell}
      editable={editable}
    />
  );
}

function GraphTabBody({
  gd,
  graph,
  graphs,
  selectedCell,
  editable,
}: Omit<GraphTabProps, 'graphId'> & { graph: NonNullable<ReturnType<typeof graphById>> }) {
  const model = useGraphModel(gd, graph);
  const { actions } = graphs;
  const locale = activeLocale();
  const viewOnly = editable ? undefined : 'you have view-only access';
  const { derivation } = model;
  const record = model.record;
  const selectedRowId =
    selectedCell !== null && selectedCell.tableId === graph.tableId ? selectedCell.rowId : null;
  const resolved = resolveSlice(derivation, graph.slice, selectedRowId);
  const matrix = coverageMatrix(derivation, resolved);
  const dimOptions = derivation.dimensions.map((d) => ({ value: d.id, label: d.label }));
  const n = (v: number) => formatNumber(locale, v);
  const pairId = graph.pairId;
  // ADR-047: a pair may be one half; the delete controls name what exists.
  const otherHalf = graphsInPair(gd, pairId).find((g) => g.id !== graph.id);
  // ONB-05 / A11Y-01 (#159 item 7): while the tour asks for the dimensions, the checklist
  // is scrolled into the rail and its first box takes focus — after a keyboard bind the
  // target that had focus has just unmounted, so the next action is one key away. Focus
  // already in the rail (the person is on the tab strip) is left alone.
  const tourSubstep = useTourGraphSubstep();
  const listRef = useRef<HTMLUListElement>(null);
  const tableId = record?.id ?? null;
  useEffect(() => {
    const list = listRef.current;
    if (tourSubstep !== 'dimensions' || list === null) return;
    if (!(list.closest('.gd-inspector')?.contains(document.activeElement) ?? false)) {
      list
        .querySelector<HTMLElement>('[role="checkbox"]:not([disabled])')
        ?.focus({ preventScroll: true });
    }
    // Scrolled after the focus: the tab strip to the top of the rail first — the card says
    // "in the Graph tab", so the tab must stay in view — then the list by the least that
    // brings all of it in (`nearest`), which at every width but a short viewport (450 px at
    // 200 % zoom) moves nothing more. Scrolled again once the rail's width transition ends:
    // while it opens from the strip its content is laid out narrow and tall, and a scroll
    // taken then lands wrong when the layout settles.
    const rail = list.closest<HTMLElement>('.gd-inspector');
    const show = () => {
      rail
        ?.querySelector<HTMLElement>('.gd-inspector__tabs [role="tablist"]')
        ?.scrollIntoView({ block: 'start', inline: 'nearest' });
      list.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    show();
    if (rail === null) return;
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === rail) show();
    };
    rail.addEventListener('transitionend', onTransitionEnd);
    return () => {
      rail.removeEventListener('transitionend', onTransitionEnd);
    };
  }, [tourSubstep, tableId]);

  return (
    <>
      <Section label="source">
        <p className="gd-insp__hint" data-testid="graph-source">
          {record === null ? 'No table bound' : record.title}
        </p>
        <div className="gd-insp__row">
          <Button
            size="sm"
            variant={record === null ? 'primary' : undefined}
            aria-disabled={viewOnly !== undefined || undefined}
            title={viewOnly === undefined ? undefined : `Re-point — ${viewOnly}`}
            onClick={
              viewOnly === undefined
                ? () => {
                    actions.repoint(pairId);
                  }
                : undefined
            }
          >
            {record === null ? 'Point at table' : 'Re-point'}
          </Button>
          <Button
            size="sm"
            aria-disabled={viewOnly !== undefined || undefined}
            title={
              viewOnly === undefined
                ? 'Add a shaped table (Dimension A · B · C · Notes) and bind it'
                : `Add shaped table — ${viewOnly}`
            }
            onClick={
              viewOnly === undefined
                ? () => {
                    actions.addShapedTable(pairId);
                  }
                : undefined
            }
          >
            Add shaped table
          </Button>
        </div>
      </Section>

      <Section
        label="dimensions"
        hint={
          record === null
            ? 'Point the graph at a table to choose its dimensions.'
            : `${n(derivation.dimensions.length)}-D matrix · ${n(derivation.tupleSpace)} possible tuples. Derived, linked and pulled columns are not offered — a context must be typeable back into its table.`
        }
      >
        {record !== null && (
          <ul
            ref={listRef}
            className="gd-graph-tab__list"
            data-testid="dimension-checklist"
            data-tour="dimensions"
          >
            {record.columns.map((column) => {
              const eligible = column.source === 'entered';
              const on = graph.dimensions.includes(column.id);
              const count = model.distinct.get(column.id) ?? 0;
              const reason =
                viewOnly ??
                (column.source === 'entered' ? undefined : readOnlyLabel(column.source));
              return (
                <li key={column.id} className="gd-graph-tab__item">
                  <Checkbox
                    id={`gd-dim-${column.id}`}
                    label={
                      <span className="gd-graph-tab__check">
                        <span className="gd-graph-tab__check-label">{column.label}</span>
                        <span className="gd-mono gd-graph-tab__count">
                          {eligible
                            ? `${n(count)} ${count === 1 ? 'value' : 'values'}`
                            : (reason ?? '')}
                        </span>
                      </span>
                    }
                    checked={on}
                    disabled={reason !== undefined}
                    onCheckedChange={(checked) => {
                      actions.toggleDimension(pairId, column.id, checked === true);
                    }}
                  />
                </li>
              );
            })}
          </ul>
        )}
        <Button
          size="sm"
          data-tour="dimensions"
          aria-disabled={viewOnly !== undefined || record === null || undefined}
          title={
            viewOnly !== undefined
              ? `Add dimension column — ${viewOnly}`
              : record === null
                ? 'Add dimension column — point the graph at a table first'
                : 'Add a column to the source table and mark it as a dimension'
          }
          onClick={
            viewOnly === undefined && record !== null
              ? () => {
                  actions.addDimensionColumn(pairId);
                }
              : undefined
          }
        >
          Add dimension column
        </Button>
      </Section>

      <Section
        label="coverage slice"
        hint="Two dimensions on the axes; every other dimension is pinned to one value."
      >
        {derivation.dimensions.length === 0 ? (
          <p className="gd-insp__hint">Mark a column as a dimension to slice the matrix.</p>
        ) : (
          <div className="gd-insp__stack">
            <Select
              label="Rows"
              size="sm"
              value={resolved.rowAxis?.id ?? ''}
              options={dimOptions}
              disabledReason={viewOnly}
              onValueChange={(value) => {
                actions.setSlice(pairId, withAxis(graph.slice, resolved, 'row', value));
              }}
            />
            <Select
              label="Columns"
              size="sm"
              value={resolved.colAxis?.id ?? ''}
              options={dimOptions}
              disabledReason={viewOnly}
              onValueChange={(value) => {
                actions.setSlice(pairId, withAxis(graph.slice, resolved, 'col', value));
              }}
            />
            {matrix.pins.map((pin) => (
              <Select
                key={pin.dimension.id}
                label={`Pin ${pin.dimension.label}`}
                size="sm"
                hint={pin.explicit ? undefined : `from the selection: ${pin.value}`}
                value={pin.explicit ? pin.value : FOLLOW_SELECTION}
                options={[
                  // GRAPH-08 (#141): the way back from an explicit pin to the default.
                  { value: FOLLOW_SELECTION, label: 'From the selection' },
                  ...pin.dimension.parameters.map((p) => ({ value: p.value, label: p.value })),
                ]}
                disabledReason={viewOnly}
                onValueChange={(value) => {
                  actions.setSlice(
                    pairId,
                    value === FOLLOW_SELECTION
                      ? withoutPin(graph.slice, pin.dimension.id)
                      : withPin(graph.slice, pin.dimension.id, value),
                  );
                }}
              />
            ))}
          </div>
        )}
      </Section>

      <Section label="contexts">
        <p className="gd-insp__hint" data-testid="graph-contexts">
          {`${n(derivation.contexts.length)} ${derivation.contexts.length === 1 ? 'context' : 'contexts'} · ${n(derivation.coveredTuples)} distinct ${derivation.coveredTuples === 1 ? 'tuple' : 'tuples'} covered of ${n(derivation.tupleSpace)} · ${n(derivation.draftCount)} draft`}
        </p>
        <p className="gd-insp__hint">
          Hover a node to light its row; click to select it; double-click (or Shift+Enter) to open a
          child sheet named after its symbol.
        </p>
      </Section>

      <Section
        label="geometry"
        hint="Whole lattice units; the ring scales to fit its box. Collapsed, the half is its header strip — one row — and keeps its box for the expand."
      >
        <Stepper
          label="Column"
          value={graph.gridCol}
          min={0}
          disabledReason={viewOnly}
          onChange={(next) => {
            actions.move(graph.id, { col: next, row: graph.gridRow });
          }}
        />
        <Stepper
          label="Row"
          value={graph.gridRow}
          min={0}
          disabledReason={viewOnly}
          onChange={(next) => {
            actions.move(graph.id, { col: graph.gridCol, row: next });
          }}
        />
        <Stepper
          label="Width"
          unit="units"
          value={graph.widthUnits}
          min={GRAPH_MIN_WIDTH_UNITS}
          disabledReason={viewOnly}
          onChange={(next) => {
            actions.resize(graph.id, { widthUnits: next, heightUnits: graph.heightUnits });
          }}
        />
        <Stepper
          label="Height"
          unit="units"
          value={graph.heightUnits}
          min={GRAPH_MIN_HEIGHT_UNITS}
          disabledReason={
            viewOnly ?? (graph.collapsed ? 'expand the graph to resize it' : undefined)
          }
          onChange={(next) => {
            actions.resize(graph.id, { widthUnits: graph.widthUnits, heightUnits: next });
          }}
        />
        {/* ADR-047: the home of collapse (DOC-02); the chevron, ⌥← / ⌥→ and the menu are routes. */}
        <Switch
          label={`Collapsed (${LABELS.collapse} / ${LABELS.expand})`}
          checked={graph.collapsed}
          disabled={!editable}
          onCheckedChange={(on) => {
            actions.setCollapsed(graph.id, on);
          }}
        />
        <p className="gd-mono gd-insp__hint">
          {`${graph.kind} at ${columnLetter(graph.gridCol)}${String(graph.gridRow + 1)}`}
        </p>
      </Section>

      <Section
        label="remove"
        hint="A half can go on its own; the other stays bound to the table. Undo restores either."
      >
        <div className="gd-insp__row">
          <Button
            size="sm"
            variant="danger"
            aria-disabled={viewOnly !== undefined || undefined}
            aria-keyshortcuts={ARIA_KEYS.clear}
            title={
              viewOnly === undefined
                ? `Delete this half only (${LABELS.clear})`
                : `Delete ${graph.kind} — ${viewOnly}`
            }
            data-testid="graph-tab-delete-half"
            onClick={
              viewOnly === undefined
                ? () => {
                    actions.removeHalf(pairId, graph.kind);
                  }
                : undefined
            }
          >
            {graph.kind === 'ring' ? 'Delete ring' : 'Delete coverage'}
          </Button>
          <Button
            size="sm"
            variant="danger"
            aria-disabled={viewOnly !== undefined || otherHalf === undefined || undefined}
            title={
              viewOnly === undefined
                ? otherHalf === undefined
                  ? 'Delete graph pair — this is the only half left'
                  : 'Delete both halves of the pair'
                : `Delete graph pair — ${viewOnly}`
            }
            data-testid="graph-tab-delete-pair"
            onClick={
              viewOnly === undefined && otherHalf !== undefined
                ? () => {
                    actions.remove(pairId);
                  }
                : undefined
            }
          >
            Delete graph pair
          </Button>
        </div>
      </Section>
    </>
  );
}
