import {
  columnLetter,
  coverageMatrix,
  graphById,
  GRAPH_MIN_HEIGHT_UNITS,
  GRAPH_MIN_WIDTH_UNITS,
  resolveSlice,
  withAxis,
  withPin,
  type GedeDoc,
  type Id,
} from '@gede/core';
import { Button, Checkbox, Select } from '@gede/ui';

import { useYVersion } from '../../../doc/use-y.js';
import { formatNumber } from '../../../intl.js';
import { activeLocale } from '../../../locale.js';
import { readOnlyLabel } from '../grid/commands.js';
import { Section, Stepper } from '../inspector/controls.js';
import type { CellSelection } from '../selection.js';
import { useGraphModel } from './use-graph-model.js';
import type { Graphs } from './use-graphs.js';

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
 * Remove. Every control writes at once (INSP-12).
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
          <ul className="gd-graph-tab__list" data-testid="dimension-checklist">
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
                hint={pin.explicit ? undefined : 'from the selection'}
                value={pin.value}
                options={pin.dimension.parameters.map((p) => ({ value: p.value, label: p.value }))}
                disabledReason={viewOnly}
                onValueChange={(value) => {
                  actions.setSlice(pairId, withPin(graph.slice, pin.dimension.id, value));
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

      <Section label="geometry" hint="Whole lattice units; the ring scales to fit its box.">
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
          disabledReason={viewOnly}
          onChange={(next) => {
            actions.resize(graph.id, { widthUnits: graph.widthUnits, heightUnits: next });
          }}
        />
        <p className="gd-mono gd-insp__hint">
          {`${graph.kind} at ${columnLetter(graph.gridCol)}${String(graph.gridRow + 1)}`}
        </p>
      </Section>

      <Section label="remove">
        <Button
          size="sm"
          aria-disabled={viewOnly !== undefined || undefined}
          title={
            viewOnly === undefined ? 'Remove both halves of the pair' : `Remove graph — ${viewOnly}`
          }
          onClick={
            viewOnly === undefined
              ? () => {
                  actions.remove(pairId);
                }
              : undefined
          }
        >
          Remove graph
        </Button>
      </Section>
    </>
  );
}
