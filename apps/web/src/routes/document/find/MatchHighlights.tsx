import clsx from 'clsx';
import type { GedeDoc, Id, SearchMatch } from '@gede/core';

import { useYVersion } from '../../../doc/use-y.js';
import { matchBounds } from './match-geometry.js';

export interface MatchHighlightsProps {
  gd: GedeDoc;
  matches: readonly SearchMatch[];
  /** Index of the current match in `matches`. */
  current: number;
  sheetId: Id | null;
  /** Viewport x at zoom 1, so cells of frozen columns follow the pinned panel (GRID-10). */
  viewportLeftPx: number;
}

/** Beyond this many highlights on one sheet the rest are left to the result list — the canvas stays at 60 fps. */
const MAX_HIGHLIGHTS = 2000;

/**
 * FIND-06: matches tint amber in place, the current one more strongly (a
 * ring as well as a deeper tint, so the state is not carried by hue alone).
 * Rendered inside the canvas layer so it pans and zooms with the tables;
 * geometry comes from the document, not the DOM, and pointer events pass
 * through to the cells beneath.
 */
export function MatchHighlights({
  gd,
  matches,
  current,
  sheetId,
  viewportLeftPx,
}: MatchHighlightsProps) {
  useYVersion(gd.tables); // a table moved or resized: recompute every rectangle
  if (matches.length === 0 || sheetId === null) return null;
  const hits: { key: string; style: React.CSSProperties; isCurrent: boolean }[] = [];
  for (let i = 0; i < matches.length && hits.length < MAX_HIGHLIGHTS; i += 1) {
    const match = matches[i];
    if (match === undefined || match.target.kind === 'document') continue;
    if (match.target.sheetId !== sheetId) continue;
    const bounds = matchBounds(gd, match, viewportLeftPx);
    if (bounds === null) continue;
    hits.push({
      key: match.id,
      isCurrent: i === current,
      style: {
        left: `${String(bounds.x)}px`,
        top: `${String(bounds.y)}px`,
        width: `${String(bounds.width)}px`,
        height: `${String(bounds.height)}px`,
      },
    });
  }
  if (hits.length === 0) return null;
  return (
    <div className="gd-find-hits" aria-hidden="true" data-testid="find-highlights">
      {hits.map((h) => (
        <div
          key={h.key}
          className={clsx('gd-find-hit', { 'gd-find-hit--current': h.isCurrent })}
          style={h.style}
          data-current={h.isCurrent || undefined}
        />
      ))}
    </div>
  );
}
