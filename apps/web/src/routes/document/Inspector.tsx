import { cellAddress, tableMap, tableRecord, type GedeDoc } from '@gede/core';
import { Button, Icon } from '@gede/ui';

import { useYVersion } from '../../doc/use-y.js';
import type { Selection } from './selection.js';
import type { InspectorMode } from './Toolbar.js';

export interface InspectorProps {
  gd: GedeDoc;
  mode: InspectorMode;
  selection: Selection | null;
  onClose: () => void;
}

/**
 * The inspector head (INSP-03, GRID-02): always states the selected object and,
 * for a cell, its computed A1 address plus row and column counts. The Format
 * and Organize tabs themselves arrive in Wave 2 and render as disabled with
 * that reason (INSP-11), never styled as operable.
 */
export function Inspector({ gd, mode, selection, onClose }: InspectorProps) {
  useYVersion(gd.tables);
  const table = selection === null ? null : tableMap(gd, selection.tableId);
  const record = table === null ? null : tableRecord(table);
  const address =
    table !== null && selection?.cell
      ? cellAddress(table, selection.cell.rowId, selection.cell.colId)
      : null;
  const tabs =
    mode === 'format' ? ['Table', 'Cell', 'Text', 'Arrange'] : ['Categories', 'Sort', 'Filter'];

  return (
    <aside
      className="gd-inspector"
      aria-label={`${mode === 'format' ? 'Format' : 'Organize'} inspector`}
    >
      <div className="gd-inspector__head">
        <span className="gd-mono gd-inspector__label">selected node</span>
        <Button
          size="sm"
          variant="ghost"
          icon={<Icon name="collapse-rail" size={13} />}
          aria-label="Collapse inspector"
          title="Collapse inspector (⌥⌘I)"
          onClick={onClose}
        />
      </div>
      <div className="gd-inspector__selected" data-testid="inspector-selected">
        {record === null ? (
          <p className="gd-inspector__none">Nothing selected</p>
        ) : (
          <>
            <p className="gd-inspector__object">{record.title}</p>
            {address !== null && (
              <p className="gd-mono gd-inspector__address" aria-label={`Address ${address}`}>
                {address}
              </p>
            )}
            <p className="gd-inspector__counts">
              {record.rows.length} {record.rows.length === 1 ? 'row' : 'rows'} ·{' '}
              {record.columns.length} {record.columns.length === 1 ? 'column' : 'columns'}
            </p>
          </>
        )}
      </div>
      <div className="gd-inspector__tabs" role="tablist" aria-label={`${mode} tabs`}>
        {tabs.map((t) => (
          <span
            key={t}
            role="tab"
            aria-selected={false}
            aria-disabled="true"
            className="gd-inspector__tab"
            title={`${t} controls arrive in Wave 2`}
          >
            {t}
          </span>
        ))}
      </div>
      <p className="gd-inspector__note">
        {mode === 'format' ? 'Format' : 'Organize'} controls arrive in Wave 2.
      </p>
    </aside>
  );
}
