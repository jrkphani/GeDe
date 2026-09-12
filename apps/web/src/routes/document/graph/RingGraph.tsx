import clsx from 'clsx';
import { useMemo, type CSSProperties } from 'react';
import {
  adjacencyOf,
  DOT_RADIUS,
  DOT_RADIUS_EMPHASISED,
  NODE_RADIUS_DENSE,
  spokesFor,
  type GraphAdjacency,
  type GraphDerivation,
  type GraphEmphasis,
  type GraphRecord,
  type Id,
  type RingLayout,
} from '@gede/core';

import { referenceColourVar } from '../formula/index.js';
import { activation, useRoving } from './roving.js';
import type { GraphsActions } from './use-graphs.js';

export interface RingGraphProps {
  graph: GraphRecord;
  derivation: GraphDerivation;
  layout: RingLayout;
  /** The source table's title (the SVG's accessible name). */
  sourceTitle: string;
  /** What is hovered or selected across the pair (GRAPH-09), or null. */
  emphasis: GraphEmphasis | null;
  /** True while the emphasis comes from a hover (mutes harder than a selection). */
  hovering: boolean;
  /** The selected cell's row when it is in the source table. */
  selectedRowId: Id | null;
  editable: boolean;
  actions: GraphsActions;
}

/** A dimension's stroke: the fixed reference palette, by dimension index. */
export function dimensionColourVar(index: number): string {
  return referenceColourVar(index);
}

/** An invisible hit circle so a dot is a 44-unit target inside the 520 space. */
const DOT_HIT_RADIUS = 16;

/**
 * The ring (GRAPH-07) on SVG: arcs, parameter dots, context nodes on their
 * orbits, and spokes for the emphasised contexts (GRAPH-09). Every node and
 * dot is focusable with a name; a complete row is a filled node, a draft is
 * hollow and dashed (GRAPH-06, A11Y-04). Hovering mutes what is not adjacent
 * across the pair. The SVG scales to its box (GRAPH-11).
 */
export function RingGraph({
  graph,
  derivation,
  layout,
  sourceTitle,
  emphasis,
  hovering,
  selectedRowId,
  editable,
  actions,
}: RingGraphProps) {
  const adjacency: GraphAdjacency = useMemo(
    () => adjacencyOf(derivation, emphasis),
    [derivation, emphasis],
  );
  const spokes = useMemo(
    () => [...adjacency.contextIds].flatMap((id) => spokesFor(layout, derivation, id)),
    [adjacency, layout, derivation],
  );
  const items = layout.nodes.length + layout.dots.length;
  const roving = useRoving(items);
  const muted = emphasis !== null;
  const muteClass = hovering ? 'gd-ring--hover' : 'gd-ring--soft';
  const contexts = new Map(derivation.contexts.map((c) => [c.id, c]));
  const tableId = graph.tableId;

  const hover = (e: GraphEmphasis | null) => {
    actions.setHover(e === null ? null : { pairId: graph.pairId, tableId, emphasis: e });
  };

  if (derivation.dimensions.length === 0) {
    return (
      <p className="gd-graph__note" data-testid="graph-no-dimensions">
        Mark at least one column as a dimension in the Graph inspector.
      </p>
    );
  }

  return (
    <svg
      className={clsx('gd-ring', { [muteClass]: muted })}
      viewBox={layout.viewBox}
      preserveAspectRatio="xMidYMid meet"
      role="group"
      aria-label={`Ring graph of ${sourceTitle}: ${String(derivation.dimensions.length)} dimensions, ${String(derivation.contexts.length)} contexts`}
      data-testid="ring-graph"
      onKeyDown={(e) => {
        roving.onKeyDown(e);
      }}
      onPointerLeave={() => {
        hover(null);
      }}
    >
      {layout.arcs.map((arc) => (
        <g key={arc.dimensionId} className="gd-ring__dimension">
          <path
            className="gd-ring__arc"
            d={arc.d}
            style={{ '--gd-dim': dimensionColourVar(arc.index) } as CSSProperties}
          />
          <text
            className="gd-mono gd-ring__arc-label"
            x={arc.labelAt.x}
            y={arc.labelAt.y}
            textAnchor={arc.anchor}
          >
            {arc.label.toUpperCase()}
          </text>
        </g>
      ))}
      <g className="gd-ring__spokes" aria-hidden="true">
        {spokes.map((s) => (
          <path
            key={`${s.contextId}|${s.dotKey}`}
            className="gd-ring__spoke"
            d={s.d}
            style={{ '--gd-dim': dimensionColourVar(s.dimensionIndex) } as CSSProperties}
            data-testid="ring-spoke"
          />
        ))}
      </g>
      {layout.dots.map((dot, i) => {
        const index = layout.nodes.length + i;
        const lit = adjacency.dotKeys.has(dot.key);
        const dim = derivation.dimensions[dot.dimensionIndex];
        const count = dim?.parameters.find((p) => p.key === dot.key)?.contextIds.length ?? 0;
        return (
          <g
            key={dot.key}
            className={clsx('gd-ring__dot', {
              'gd-ring__dot--lit': lit,
              'gd-ring__dot--muted': muted && !lit,
            })}
            style={{ '--gd-dim': dimensionColourVar(dot.dimensionIndex) } as CSSProperties}
            role="button"
            tabIndex={roving.tabIndex(index)}
            aria-label={`${dim?.label ?? 'Parameter'} ${dot.value}: ${String(count)} ${count === 1 ? 'context' : 'contexts'}`}
            data-graph-item={index}
            data-dot-key={dot.key}
            onFocus={() => {
              roving.onFocus(index);
              hover({ role: 'parameter', key: dot.key });
            }}
            onBlur={() => {
              hover(null);
            }}
            onPointerEnter={() => {
              hover({ role: 'parameter', key: dot.key });
            }}
            onPointerDown={(e) => {
              // Take focus without the browser's scroll-into-view: the plane is a
              // transformed layer, not a scroller, and must never be scrolled.
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.focus({ preventScroll: true });
              actions.select(graph.id);
            }}
            onKeyDown={(e) => {
              if (activation(e) === null) return;
              e.preventDefault();
              hover({ role: 'parameter', key: dot.key });
            }}
          >
            <circle className="gd-ring__dot-hit" cx={dot.at.x} cy={dot.at.y} r={DOT_HIT_RADIUS} />
            <circle
              className="gd-ring__dot-mark"
              cx={dot.at.x}
              cy={dot.at.y}
              r={lit ? DOT_RADIUS_EMPHASISED : DOT_RADIUS}
            />
            <text
              className="gd-ring__dot-label"
              x={dot.labelAt.x}
              y={dot.labelAt.y}
              textAnchor={dot.anchor}
            >
              {dot.label}
            </text>
          </g>
        );
      })}
      {layout.nodes.map((node, index) => {
        const context = contexts.get(node.contextId);
        const lit = adjacency.contextIds.has(node.contextId);
        const selected = selectedRowId === node.contextId;
        const tuple = context?.tupleKey ?? '';
        return (
          <g
            key={node.contextId}
            className={clsx('gd-ring__node', {
              'gd-ring__node--complete': node.complete,
              'gd-ring__node--draft': !node.complete,
              'gd-ring__node--selected': selected,
              'gd-ring__node--muted': muted && !lit,
              'gd-ring__node--dense': layout.nodeRadius === NODE_RADIUS_DENSE,
            })}
            transform={`translate(${String(node.at.x)} ${String(node.at.y)})`}
            role="button"
            tabIndex={roving.tabIndex(index)}
            aria-pressed={selected}
            aria-label={`Context ${node.symbol}: ${tuple}, ${node.complete ? 'complete' : 'draft'}`}
            data-graph-item={index}
            data-context-id={node.contextId}
            data-complete={node.complete}
            onFocus={() => {
              roving.onFocus(index);
              hover({ role: 'context', id: node.contextId });
            }}
            onBlur={() => {
              hover(null);
            }}
            onPointerEnter={() => {
              hover({ role: 'context', id: node.contextId });
            }}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.focus({ preventScroll: true });
              actions.select(graph.id);
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (tableId !== null) actions.selectRow(tableId, node.contextId);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (editable && context !== undefined) actions.openChild(context);
            }}
            onKeyDown={(e) => {
              const what = activation(e);
              if (what === null) return;
              e.preventDefault();
              e.stopPropagation();
              if (what === 'open') {
                if (editable && context !== undefined) actions.openChild(context);
              } else if (tableId !== null) {
                actions.selectRow(tableId, node.contextId);
              }
            }}
          >
            <circle className="gd-ring__node-mark" r={node.radius} />
            <text
              className="gd-mono gd-ring__symbol"
              textAnchor="middle"
              dominantBaseline="central"
            >
              {node.symbol}
            </text>
          </g>
        );
      })}
      {layout.nodes.length === 0 && (
        <text className="gd-ring__empty" x="260" y="262" textAnchor="middle">
          Type into a row of the table to place the first context
        </text>
      )}
    </svg>
  );
}
