import type { GedeDoc, Id } from '@gede/core';
import type * as Y from 'yjs';

import { DerivedColumnPanel } from './DerivedColumnPanel.js';
import { MappingColumnPanel, PullPanel } from './RelationPanels.js';

export interface DerivePanelProps {
  gd: GedeDoc;
  tableId: Id;
  /** The selected cell's column, pre-selected as the derive source. */
  sourceColId?: Id | undefined;
  undo?: Y.UndoManager | null | undefined;
  editable?: boolean | undefined;
}

/**
 * Format — Derive (PRD §18): cross-table relation (pull, mapping) and
 * derived-column composition with the pipeline audit list, stacked. The
 * inspector owner mounts this for the selected table; each part is also
 * exported on its own.
 */
export function DerivePanel(props: DerivePanelProps) {
  return (
    <div data-testid="derive-panel">
      <DerivedColumnPanel {...props} />
      <PullPanel {...props} />
      <MappingColumnPanel {...props} />
    </div>
  );
}
