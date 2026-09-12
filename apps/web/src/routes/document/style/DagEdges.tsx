/**
 * INSP-07 / PRD §7 "Connecting Edges": the table-to-table dependency edges
 * of a sheet, drawn once the sheet's flag is on. Each edge runs from the
 * table read (its right edge) to the table whose formulas read it (its left
 * edge), dashed in the accent rule with the number of reading cells at its
 * end — a count, so the edge never carries meaning by hue alone (A11Y-04).
 * Edges into another sheet are not drawn; the Arrange tab counts them (PRD
 * §11). Mounted inside `<Canvas>` after the tables, so it pans and zooms
 * with them; the stroke keeps its screen width (`vector-effect`). PRD §20
 * reserves a canvas layer for edges "once they number in the hundreds" —
 * this SVG is the DOM-first form for the tens a sheet has today.
 */
import { useMemo } from 'react';
import {
  dagEdges,
  sheetEdgesShown,
  tableById,
  tableMap,
  tableUnitBounds,
  unitBoundsToPx,
  type GedeDoc,
  type Id,
} from '@gede/core';

import { useYVersion } from '../../../doc/use-y.js';

export interface DagEdgesProps {
  gd: GedeDoc;
  sheetId: Id | null;
}

interface Drawn {
  readonly key: string;
  readonly d: string;
  readonly end: { x: number; y: number };
  readonly count: number;
  readonly title: string;
}

export function DagEdges({ gd, sheetId }: DagEdgesProps) {
  const version = useYVersion(gd.tables);
  const sheetsVersion = useYVersion(gd.sheets);
  const shown = sheetId !== null && sheetEdgesShown(gd, sheetId);
  const drawn = useMemo<Drawn[]>(() => {
    if (sheetId === null || !shown) return [];
    const out: Drawn[] = [];
    for (const edge of dagEdges(gd, sheetId)) {
      if (edge.crossSheet) continue;
      const from = tableMap(gd, edge.from);
      const to = tableMap(gd, edge.to);
      if (from === null || to === null) continue;
      const a = unitBoundsToPx(tableUnitBounds(from));
      const b = unitBoundsToPx(tableUnitBounds(to));
      const start = { x: a.x + a.width, y: a.y + a.height / 2 };
      const end = { x: b.x, y: b.y + b.height / 2 };
      const dx = Math.max(40, Math.abs(end.x - start.x) / 2);
      const d = `M ${String(start.x)} ${String(start.y)} C ${String(start.x + dx)} ${String(start.y)}, ${String(end.x - dx)} ${String(end.y)}, ${String(end.x)} ${String(end.y)}`;
      const fromTitle = tableById(gd, edge.from)?.title ?? edge.from;
      const toTitle = tableById(gd, edge.to)?.title ?? edge.to;
      out.push({
        key: `${edge.from}>${edge.to}`,
        d,
        end,
        count: edge.count,
        title: `${toTitle} reads ${fromTitle} in ${String(edge.count)} ${edge.count === 1 ? 'cell' : 'cells'}`,
      });
    }
    return out;
    // `version` and `sheetsVersion` tick on every document change.
  }, [gd, sheetId, shown, version, sheetsVersion]);

  if (!shown) return null;
  return (
    <svg
      className="gd-edges"
      width="0"
      height="0"
      role="img"
      aria-label={
        drawn.length === 0
          ? 'No DAG edges on this sheet'
          : `${String(drawn.length)} DAG ${drawn.length === 1 ? 'edge' : 'edges'}`
      }
      data-testid="dag-edges"
      data-count={drawn.length}
    >
      {drawn.map((e) => (
        <g key={e.key} data-edge={e.key}>
          <title>{e.title}</title>
          <path className="gd-edges__path" d={e.d} />
          <circle className="gd-edges__end" cx={e.end.x} cy={e.end.y} r={3} />
          <text className="gd-edges__label" x={e.end.x - 6} y={e.end.y - 6} textAnchor="end">
            {e.count}
          </text>
        </g>
      ))}
    </svg>
  );
}
