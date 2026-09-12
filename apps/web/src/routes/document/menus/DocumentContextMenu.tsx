import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { listSheets, type GedeDoc } from '@gede/core';
import { ContextMenu } from '@gede/ui';

import { useYVersion } from '../../../doc/use-y.js';
import type { GridActions } from '../grid/use-grid.js';
import { menuEntriesFor, menuLabelFor, type MenuContext, type MenuTarget } from './entries.js';

/** Radix's long-press delay, so touch behaves the same as any other Radix context menu. */
const LONG_PRESS_MS = 700;
/** Finger movement that turns a press into a pan (CSS px). */
const LONG_PRESS_SLOP_PX = 10;

export interface DocumentContextMenuProps {
  gd: GedeDoc;
  /** RESP-02: no context menu on phone — nothing opens. */
  phone: boolean;
  context: MenuContext;
  actions: GridActions;
  /** The shell keeps Escape for the menu while one is open (D7). */
  onOpenChange?: ((open: boolean) => void) | undefined;
  children: ReactNode;
}

/**
 * Which object a pointer or keyboard gesture inside the document lands on.
 * Resolved from the DOM the grid renders (`data-table-id`, `data-row-id`,
 * `data-col-id`, the sheet tab strip, the canvas plane), so the menus never
 * keep a second model of the document.
 */
export function resolveMenuTarget(gd: GedeDoc, node: EventTarget | null): MenuTarget | null {
  if (!(node instanceof Element)) return null;
  const table = node.closest<HTMLElement>('[data-table-id]');
  if (table !== null) {
    const tableId = table.dataset.tableId ?? '';
    const cell = node.closest<HTMLElement>('[role="gridcell"][data-row-id][data-col-id]');
    if (cell !== null) {
      return {
        kind: 'cell',
        tableId,
        rowId: cell.dataset.rowId ?? '',
        colId: cell.dataset.colId ?? '',
      };
    }
    const header = node.closest<HTMLElement>('[role="columnheader"][data-col-id]');
    if (header !== null) return { kind: 'column', tableId, colId: header.dataset.colId ?? '' };
    return { kind: 'table', tableId };
  }
  const sheetTab = node.closest<HTMLElement>('.gd-doc__sheets [role="tab"]');
  if (sheetTab !== null) {
    const list = sheetTab.parentElement;
    const index =
      list === null ? -1 : Array.from(list.querySelectorAll('[role="tab"]')).indexOf(sheetTab);
    const sheet = listSheets(gd)[index];
    return sheet === undefined ? null : { kind: 'sheet', sheetId: sheet.id };
  }
  if (node.closest('.gd-canvas__plane') !== null) return { kind: 'canvas' };
  return null;
}

function selectedCellElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="gridcell"][aria-selected="true"]');
}

function selectedKey(cell: HTMLElement | null): string | null {
  if (cell === null) return null;
  const table = cell.closest<HTMLElement>('[data-table-id]');
  return `${table?.dataset.tableId ?? ''}:${cell.dataset.rowId ?? ''}:${cell.dataset.colId ?? ''}`;
}

/**
 * MENU-01..05: one Radix ContextMenu over the whole document body. A
 * right-click, long-press (RESP-03) or Shift+F10 / ContextMenu key resolves
 * what it landed on, selects it the way a click would, and builds that
 * object's entries. Escape or a click outside closes; focus returns to the
 * element that had it (MENU-05).
 */
export function DocumentContextMenu({
  gd,
  phone,
  context,
  actions,
  onOpenChange,
  children,
}: DocumentContextMenuProps) {
  useYVersion(gd.tables);
  const [target, setTarget] = useState<MenuTarget | null>(null);
  // RESP-03: long-press. The cells stop `pointerdown` propagating (the canvas would pan),
  // so Radix's own timer never starts; this one runs from the capture phase instead and
  // opens the menu the way the keyboard does — with a `contextmenu` event at the point.
  const longPress = useRef<{ timer: number; x: number; y: number; el: HTMLElement } | null>(null);
  // The finger lifting after a long-press also raises a click, now over the menu that
  // opened under it; that click must not pick the item it happens to land on.
  const swallowClicksUntil = useRef(0);
  const cancelLongPress = () => {
    if (longPress.current === null) return;
    window.clearTimeout(longPress.current.timer);
    longPress.current = null;
  };
  useEffect(() => cancelLongPress, []);
  const swallowFreshClick = (event: SyntheticEvent) => {
    if (performance.now() >= swallowClicksUntil.current) return;
    event.preventDefault();
    event.stopPropagation();
  };
  // The cell selected as the menu opened (the right-click selects first), so the close can
  // tell whether a command moved the selection.
  const selectionAtOpen = useRef<string | null>(null);
  const entries = target === null ? [] : menuEntriesFor(context, target);
  return (
    <ContextMenu
      disabled={phone}
      label={target === null ? undefined : menuLabelFor(target)}
      entries={entries}
      onOpenChange={(open) => {
        if (!open) setTarget(null);
        onOpenChange?.(open);
      }}
      // MENU-05: back to the trigger — the header a column menu opened on, or the cell that had
      // focus — unless a command moved the selection (an inserted row, the neighbour of a deleted
      // one), in which case the new cell is where the keyboard should be.
      returnFocus={(opener) => {
        const selected = selectedCellElement();
        const moved = selectedKey(selected) !== selectionAtOpen.current;
        if (!moved && opener?.isConnected === true && opener.matches('[role="columnheader"]')) {
          return opener;
        }
        return selected ?? opener;
      }}
      trigger={
        <div
          className="gd-doc__menu-scope"
          data-testid="menu-scope"
          onPointerDownCapture={(event) => {
            if (phone || event.pointerType === 'mouse') return;
            const next = resolveMenuTarget(gd, event.target);
            if (next === null || !(event.target instanceof HTMLElement)) return;
            cancelLongPress();
            const el = event.target;
            const { clientX: x, clientY: y } = event;
            longPress.current = {
              x,
              y,
              el,
              timer: window.setTimeout(() => {
                longPress.current = null;
                swallowClicksUntil.current = performance.now() + LONG_PRESS_MS;
                el.dispatchEvent(
                  new MouseEvent('contextmenu', {
                    bubbles: true,
                    cancelable: true,
                    clientX: x,
                    clientY: y,
                  }),
                );
              }, LONG_PRESS_MS),
            };
          }}
          onPointerMoveCapture={(event) => {
            const press = longPress.current;
            if (press === null) return;
            // A drag is a pan, not a press.
            if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > LONG_PRESS_SLOP_PX) {
              cancelLongPress();
            }
          }}
          onPointerUpCapture={cancelLongPress}
          onPointerCancelCapture={cancelLongPress}
          // The compat mouse events and the click the lift raises: swallowed while the menu
          // is fresh, so focus stays put (a focus change would dismiss the menu) and nothing
          // under the finger is picked.
          onMouseDownCapture={swallowFreshClick}
          onMouseUpCapture={swallowFreshClick}
          onClickCapture={swallowFreshClick}
          onContextMenuCapture={(event) => {
            cancelLongPress(); // the browser's own long-press contextmenu, or ours
            if (phone) return;
            const next = resolveMenuTarget(gd, event.target);
            if (next === null) {
              // Nothing of ours under the pointer: leave the browser's menu alone.
              event.stopPropagation();
              return;
            }
            setTarget(next);
            // A right-click selects like a left-click does (desktop parity, MENU-01).
            if (next.kind === 'cell') {
              actions.selectCell({ tableId: next.tableId, rowId: next.rowId, colId: next.colId });
              selectionAtOpen.current = `${next.tableId}:${next.rowId}:${next.colId}`;
            } else {
              if (next.kind === 'column' || next.kind === 'table') {
                if (context.selectedCell?.tableId !== next.tableId)
                  actions.selectTable(next.tableId);
              }
              selectionAtOpen.current = selectedKey(selectedCellElement());
              // MENU-05: the header is the trigger of a column menu, so focus can come back to it
              // (headers take focus only this way — they are not in the tab order).
              if (next.kind === 'column' && event.target instanceof Element) {
                event.target
                  .closest<HTMLElement>('[role="columnheader"]')
                  ?.focus({ preventScroll: true });
              }
            }
          }}
        >
          {children}
        </div>
      }
    />
  );
}
