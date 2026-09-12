import { useEffect, useState } from 'react';
import { Button, Menu, type MenuEntry } from '@gede/ui';
import type * as Y from 'yjs';

import { LABELS } from '../../../doc/shortcuts.js';

export interface DocumentMenuProps {
  /** SHARE-03 / RESP-02: undo and redo are writes; a viewer sees them disabled with the reason. */
  editable: boolean;
  undo: Y.UndoManager;
  /** KEYS-02 ⌘O: back to the library. */
  onOpen: () => void;
  /** KEYS-02 ⌘P. */
  onPrint: () => void;
}

/**
 * The Document menu in the toolbar (KEYS-02, KEYS-03, KEYS-08, ADR-038): the
 * pointer route for the chords that had none — Open (⌘O), Print (⌘P), Undo
 * (⌘Z) and Redo (⇧⌘Z) — each beside its shortcut. ⌘N and ⌘W are the
 * browser's in Chrome and Safari (ADR-030) and are not listed here: the
 * library's + and the mark back to the library are their routes.
 */
export function DocumentMenu({ editable, undo, onOpen, onPrint }: DocumentMenuProps) {
  // The manager's stacks are not React state; re-read them on every change it reports.
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => {
      setTick((t) => t + 1);
    };
    undo.on('stack-item-added', bump);
    undo.on('stack-item-popped', bump);
    undo.on('stack-cleared', bump);
    return () => {
      undo.off('stack-item-added', bump);
      undo.off('stack-item-popped', bump);
      undo.off('stack-cleared', bump);
    };
  }, [undo]);
  const viewOnly = editable ? undefined : 'you have view-only access';
  const entries: MenuEntry[] = [
    {
      kind: 'item',
      id: 'open',
      label: 'Open the library',
      shortcut: LABELS.open,
      onSelect: onOpen,
    },
    { kind: 'item', id: 'print', label: 'Print', shortcut: LABELS.print, onSelect: onPrint },
    { kind: 'separator', id: 's1' },
    {
      kind: 'item',
      id: 'undo',
      label: 'Undo',
      shortcut: LABELS.undo,
      disabledReason: viewOnly ?? (undo.canUndo() ? undefined : 'nothing to undo'),
      onSelect: () => {
        undo.undo();
      },
    },
    {
      kind: 'item',
      id: 'redo',
      label: 'Redo',
      shortcut: LABELS.redo,
      disabledReason: viewOnly ?? (undo.canRedo() ? undefined : 'nothing to redo'),
      onSelect: () => {
        undo.redo();
      },
    },
  ];
  return (
    <Menu
      label="Document"
      align="start"
      entries={entries}
      trigger={
        <Button
          size="sm"
          variant="ghost"
          className="gd-tool gd-tool--text"
          aria-label="Document menu"
        >
          Document
        </Button>
      }
    />
  );
}
