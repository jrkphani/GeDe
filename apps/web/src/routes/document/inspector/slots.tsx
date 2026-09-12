/**
 * Tabs whose controls are built by other Wave 2 work and mounted here once
 * they land. Each renders its slot marker and the disabled explanation the
 * inspector convention requires (INSP-11) — never an empty pane.
 *
 *   slot: hierarchy  → Categories tab body (`SortPanel`, grouping; row depth lives in the Table tab)
 *   slot: sort       → Sort tab body (`SortPanel`)
 *   slot: filter     → Filter tab body (`SortPanel`)
 *   slot: derive     → cross-table relation, derived-column composition, pipeline audit (#77)
 *   slot: graph      → INSP-08, shown only when a graph is selected
 */
import type { ReactNode } from 'react';

import { Section, Slot, Unavailable } from './controls.js';

export interface InspectorSlots {
  /** Mounted by the hierarchy PR: the Categories tab body. */
  hierarchy?: ReactNode | undefined;
  /** Mounted by the sort/filter PR: the Sort tab body. */
  sort?: ReactNode | undefined;
  /** Mounted by the sort/filter PR: the Filter tab body. */
  filter?: ReactNode | undefined;
  /** Derive tab body (INSP-09). */
  derive?: ReactNode | undefined;
  /** Graph tab body (INSP-08); the tab renders only when this is set. */
  graph?: ReactNode | undefined;
}

export function CategoriesTab({ slot }: { slot: ReactNode | undefined }) {
  if (slot !== undefined) return <>{slot}</>;
  return (
    <Section label="categories">
      {/* slot: hierarchy */}
      <Slot
        name="hierarchy"
        reason="Categories are the sort and filter release's SortPanel (#74)."
      />
    </Section>
  );
}

export function SortTab({ slot }: { slot: ReactNode | undefined }) {
  if (slot !== undefined) return <>{slot}</>;
  return (
    <Section label="sort">
      {/* slot: sort */}
      <Slot name="sort" reason="Sorting is the sort and filter release's SortPanel (#74)." />
    </Section>
  );
}

export function FilterTab({ slot }: { slot: ReactNode | undefined }) {
  if (slot !== undefined) return <>{slot}</>;
  return (
    <Section label="filter">
      {/* slot: sort */}
      <Slot name="filter" reason="Filters are the sort and filter release's SortPanel (#74)." />
    </Section>
  );
}

/**
 * INSP-09: the Derive tab. Its hierarchy controls (HIER-01) shipped with the
 * hierarchy release and mount here through `hierarchy`; the cross-table
 * relation, derived-column composition and pipeline audit wait for `slot`.
 */
export function DeriveTab({
  slot,
  hierarchy,
}: {
  slot: ReactNode | undefined;
  hierarchy: ReactNode;
}) {
  if (slot !== undefined) return <>{slot}</>;
  return (
    <>
      {/* The panel is its own labelled section (`.gd-hier`), styled as one rail block. */}
      {hierarchy}
      <Section label="relate to another table">
        <Slot
          name="derive"
          reason="Cross-table relations arrive with the references release (#77)."
        />
      </Section>
      <Section label="derive column">
        <Unavailable
          label="Add a derived column"
          reason="arrives with the references release (#77)"
        />
      </Section>
      <Section label="pipeline">
        <Slot
          name="derive"
          reason="The pipeline audit list arrives with the references release (#77)."
        />
      </Section>
    </>
  );
}
