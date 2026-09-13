import clsx from 'clsx';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { listSheets, objectCount, type GedeDoc, type Id, type SheetRecord } from '@gede/core';
import { Button, Tabs, Tooltip } from '@gede/ui';

import { announce } from '../../announce.js';
import { isEditableTarget } from '../../doc/shortcuts.js';
import { useYVersion } from '../../doc/use-y.js';
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

function isComposing(event: KeyboardEvent): boolean {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- keyCode 229 is the legacy IME signal
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

interface RenameFieldProps {
  sheet: SheetRecord;
  commit: (label: string) => boolean;
  cancel: () => void;
}

/**
 * The inline name field that stands in for a tab (ADR-048). Enter commits,
 * Escape cancels, leaving the field commits what is there; an empty name is
 * refused with the reason beside the field and in the live region. Keys
 * resolve from `event.code` and nothing happens while an IME composes.
 */
function RenameField({ sheet, commit, cancel }: RenameFieldProps) {
  const [invalid, setInvalid] = useState(false);
  const reasonId = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const done = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (how: 'commit' | 'cancel') => {
    if (done.current) return;
    const value = input.current?.value ?? '';
    if (how === 'commit') {
      if (value.trim() !== '' && commit(value)) {
        done.current = true;
        return;
      }
      setInvalid(true);
      announce(emptyNameReason());
      input.current?.focus();
      return;
    }
    done.current = true;
    cancel();
  };
  const reason = emptyNameReason();
  return (
    <>
      <input
        ref={input}
        className="gd-doc__sheet-rename"
        type="text"
        defaultValue={sheet.label}
        aria-label="Sheet name"
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? reasonId : undefined}
        // The reason shows where the missing name would be — exactly while it applies (A11Y-04).
        placeholder={invalid ? reason : undefined}
        data-sheet-rename={sheet.id}
        autoComplete="off"
        spellCheck={false}
        onChange={() => {
          if (invalid) setInvalid(false);
        }}
        onKeyDown={(event) => {
          if (isComposing(event)) return;
          if (event.code === 'Enter' || event.code === 'NumpadEnter') {
            event.preventDefault();
            event.stopPropagation();
            finish('commit');
          } else if (event.code === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            finish('cancel');
          }
        }}
        onBlur={() => {
          // Leaving the field keeps a typed name; an empty one is not kept, and the tab returns.
          if ((input.current?.value ?? '').trim() === '') finish('cancel');
          else finish('commit');
        }}
      />
      {invalid && (
        <span id={reasonId} className="gd-visually-hidden">
          {reason}
        </span>
      )}
    </>
  );
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
    if (edit === undefined || isComposing(event) || event.defaultPrevented) return;
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
              editor:
                edit !== undefined && renaming === s.id ? (
                  <RenameField
                    sheet={s}
                    commit={(label) => edit.commitRename(s.id, label)}
                    cancel={edit.cancelRename}
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
