import clsx from 'clsx';
import { useEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { listSheets, objectCount, type GedeDoc, type Id } from '@gede/core';
import { Button, Tabs, Tooltip } from '@gede/ui';

import { isEditableTarget } from '../../doc/shortcuts.js';
import { useYVersion } from '../../doc/use-y.js';
import { InlineNameField, isComposingEvent } from './InlineNameField.js';
import { emptyNameReason } from './sheets.js';

/**
 * ADR-048: what a tab can do to its sheet beyond selecting it. Absent on
 * phone (RESP-02) and for view-only participants, so no rename field, no
 * ⌫ and no F2 exist there; the tab menu's items say why instead (MENU-02).
 */
export interface SheetEditing {
  /** The sheet whose tab is an inline name field right now, or null. */
  renaming: Id | null;
  /** F2, double-click, or the tab menu's Rename sheet. */
  startRename: (sheetId: Id) => void;
  /**
   * The typed name, trimmed by the document. False when it was refused
   * (empty): the field stays open and says why.
   */
  commitRename: (sheetId: Id, label: string) => boolean;
  cancelRename: () => void;
  /** ⌫ on a focused tab, or the tab menu's Delete sheet. */
  remove: (sheetId: Id) => void;
}

export interface SheetTabsProps {
  gd: GedeDoc;
  activeSheetId: Id | null;
  onSelect: (sheetId: Id) => void;
  /** Absent on phone (RESP-02) and for view-only participants. */
  onAppend?: (() => void) | undefined;
  edit?: SheetEditing | undefined;
  bottom: boolean;
}

/** The tab's own keys (KEYS, I18N-02): F2 renames, ⌫ deletes; nothing while an IME composes. */
function tabOf(target: EventTarget | null): { element: HTMLElement; sheetId: Id } | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>('[role="tab"][data-value]');
  const sheetId = element?.dataset.value;
  return element === null || sheetId === undefined ? null : { element, sheetId };
}

/**
 * DOC-03: ordinal, name and object count per sheet; a trailing + appends.
 * ADR-048: a tab renames inline (F2, double-click, menu) and deletes (⌫,
 * menu); the tab's context menu is the document's (`DocumentContextMenu`).
 */
export function SheetTabs({ gd, activeSheetId, onSelect, onAppend, edit, bottom }: SheetTabsProps) {
  useYVersion(gd.sheets); // deep: a sheet label lives in a nested map
  useYVersion(gd.tables, { depth: 'shallow' });
  useYVersion(gd.graphs, { depth: 'shallow' });
  const sheets = listSheets(gd);
  const value = activeSheetId ?? sheets[0]?.id ?? '';
  const strip = useRef<HTMLElement | null>(null);
  const renaming = edit?.renaming ?? null;
  // Where focus should land once this render has settled: the tab of `sheetId`, when
  // focus was on a tab that went (a deleted one, or one that gave way to the name field).
  const focusAfter = useRef<Id | null>(null);
  const wasRenaming = useRef<Id | null>(null);
  useEffect(() => {
    if (wasRenaming.current !== null && renaming === null) focusAfter.current = wasRenaming.current;
    wasRenaming.current = renaming;
  }, [renaming]);
  useEffect(() => {
    const wanted = focusAfter.current;
    if (wanted === null) return;
    const active = document.activeElement;
    // Focus is elsewhere on purpose (a cell, the menu's return target): leave it.
    if (active !== null && active !== document.body && active.isConnected) {
      if (strip.current?.contains(active) !== true) {
        focusAfter.current = null;
        return;
      }
    }
    const wantedTab = strip.current?.querySelector<HTMLElement>(
      `[role="tab"][data-value="${wanted}"]`,
    );
    // Focusing an inactive Radix tab activates it (automatic activation), so a sheet renamed
    // from its menu while another is shown would become the shown one — and its "Renamed …"
    // announcement would be talked over by the selection's. The keyboard is put on the tab
    // when it is the active sheet's; otherwise on the active tab, which changes nothing.
    const tab =
      wantedTab?.getAttribute('aria-selected') === 'true'
        ? wantedTab
        : strip.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    focusAfter.current = null;
    tab?.focus({ preventScroll: true });
  });
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (edit === undefined || isComposingEvent(event) || event.defaultPrevented) return;
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    const isDelete = (event.code === 'Delete' || event.code === 'Backspace') && plain;
    const tab = tabOf(event.target);
    if (tab === null) {
      // ⌫ anywhere else in the strip (the + button) belongs to nothing: claimed so the
      // shell's ⌫ never acts on the canvas selection while focus is here (#165 §5).
      if (isDelete && !isEditableTarget(event.target)) event.preventDefault();
      return;
    }
    if (event.code === 'F2' && plain) {
      event.preventDefault();
      event.stopPropagation();
      edit.startRename(tab.sheetId);
    } else if (isDelete) {
      // The tab owns ⌫ (KEYS-03): the shell's binding never sees it.
      event.preventDefault();
      event.stopPropagation();
      focusAfter.current = tab.sheetId;
      edit.remove(tab.sheetId);
    }
  };
  const onDoubleClick = (event: MouseEvent<HTMLElement>) => {
    if (edit === undefined) return;
    const tab = tabOf(event.target);
    if (tab === null) return;
    event.preventDefault();
    edit.startRename(tab.sheetId);
  };
  return (
    <footer
      ref={strip}
      className={clsx('gd-doc__sheets', { 'gd-doc__sheets--bottom': bottom })}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
    >
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
              // ADR-048: the inline name field stands in for the tab; the strip's own focus
              // rule puts the keyboard back on a tab once it goes (never on an inactive one).
              editor:
                edit !== undefined && renaming === s.id ? (
                  <InlineNameField
                    value={s.label}
                    label="Sheet name"
                    emptyReason={emptyNameReason()}
                    commit={(label) =>
                      edit.commitRename(s.id, label)
                        ? { ok: true }
                        : { ok: false, reason: emptyNameReason() }
                    }
                    cancel={edit.cancelRename}
                    className="gd-doc__sheet-rename"
                    data={{ 'data-sheet-rename': s.id }}
                  />
                ) : undefined,
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
