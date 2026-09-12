import { LATTICE, lineageOf, type TableRecord } from '@gede/core';

export interface LineageHeaderProps {
  record: TableRecord;
}

/**
 * The lineage header of a table with derived columns (REF-04, PRD §4 "A →
 * B → C share a horizontal audit trail"): one band over the source columns,
 * one over the derived pipeline, each as wide as the columns it spans. It
 * sits on the second line of the title bar rather than in a lattice row of
 * its own, so adding a derived column never moves an address (non-negotiable
 * 3; ADR-032). Nothing when the table has no derived column.
 */
export function LineageHeader({ record }: LineageHeaderProps) {
  const bands = lineageOf(record);
  if (bands.length === 0) return null;
  return (
    <div className="gd-lineage" data-testid="lineage-header" aria-label="Column lineage">
      {bands.map((band, i) => (
        <span
          key={i}
          className={`gd-lineage__band gd-lineage__band--${band.kind}`}
          style={{ width: `${String(band.units * LATTICE.col)}px` }}
          title={band.label}
        >
          {band.label}
        </span>
      ))}
    </div>
  );
}
