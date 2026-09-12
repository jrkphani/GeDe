import clsx from 'clsx';
import { listSheets, objectCount, type GedeDoc, type Id } from '@gede/core';
import { Button, Tabs, Tooltip } from '@gede/ui';

import { useYVersion } from '../../doc/use-y.js';

export interface SheetTabsProps {
  gd: GedeDoc;
  activeSheetId: Id | null;
  onSelect: (sheetId: Id) => void;
  /** Absent on phone (RESP-02) and for view-only participants. */
  onAppend?: (() => void) | undefined;
  bottom: boolean;
}

/** DOC-03: ordinal, name and object count per sheet; a trailing + appends. */
export function SheetTabs({ gd, activeSheetId, onSelect, onAppend, bottom }: SheetTabsProps) {
  useYVersion(gd.sheets); // deep: a sheet label lives in a nested map
  useYVersion(gd.tables, { depth: 'shallow' });
  useYVersion(gd.graphs, { depth: 'shallow' });
  const sheets = listSheets(gd);
  const value = activeSheetId ?? sheets[0]?.id ?? '';
  return (
    <footer className={clsx('gd-doc__sheets', { 'gd-doc__sheets--bottom': bottom })}>
      {sheets.length > 0 && (
        <Tabs
          label="Sheets"
          value={value}
          onChange={onSelect}
          items={sheets.map((s) => {
            const count = objectCount(gd, s.id);
            return {
              value: s.id,
              label: (
                <span className="gd-doc__sheet">
                  <span className="gd-mono gd-doc__sheet-ordinal">{s.ordinal}°</span>
                  <span className="gd-doc__sheet-name">{s.label}</span>
                  <span
                    className="gd-mono gd-doc__sheet-count"
                    aria-label={`${String(count)} ${count === 1 ? 'object' : 'objects'}`}
                  >
                    {count}
                  </span>
                </span>
              ),
            };
          })}
        />
      )}
      {onAppend !== undefined && (
        <Tooltip content="Add sheet">
          <Button
            size="sm"
            variant="ghost"
            className="gd-doc__add-sheet"
            aria-label="Add sheet"
            onClick={onAppend}
          >
            +
          </Button>
        </Tooltip>
      )}
    </footer>
  );
}
