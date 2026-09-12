/**
 * The one cell editor that is open, as the rest of the document sees it:
 * its live draft (so `FormulaLayer` outlines the operands as they are typed,
 * FX-08) and a way to hand it a clicked cell's address (FX-05). Viewer state,
 * never document state; one editor at a time by construction (GRID-06).
 */
import { useSyncExternalStore } from 'react';
import type { Id } from '@gede/core';

export interface FormulaEditingState {
  readonly tableId: Id;
  readonly rowId: Id;
  readonly colId: Id;
  /** The textarea's current value. */
  readonly draft: string;
  /** True when the draft is a formula: cell clicks insert instead of selecting. */
  readonly formula: boolean;
}

interface Handle {
  state: FormulaEditingState;
  insert: (address: string) => void;
}

let active: Handle | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const cb of listeners) cb();
}

/** The editor registers on mount and updates on every keystroke; returns the unregister. */
export function registerFormulaEditor(handle: Handle): () => void {
  active = handle;
  emit();
  return () => {
    if (active === handle) {
      active = null;
      emit();
    }
  };
}

export function updateFormulaEditor(handle: Handle, state: FormulaEditingState): void {
  if (active !== handle) return;
  handle.state = state;
  emit();
}

/**
 * FX-05: a cell was pressed while a formula is being edited. Returns true
 * when the address went into the draft, in which case the caller must not
 * move the selection (and should cancel the pointer default so the editor
 * keeps focus).
 */
export function insertClickedAddress(address: string): boolean {
  const editor = active;
  if (editor === null) return false;
  if (!editor.state.formula) return false;
  editor.insert(address);
  return true;
}

export function currentFormulaEditing(): FormulaEditingState | null {
  return active?.state ?? null;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** The open editor's state, or null; re-renders on each keystroke of a formula draft. */
export function useFormulaEditing(): FormulaEditingState | null {
  return useSyncExternalStore(subscribe, currentFormulaEditing, () => null);
}

/** Test seam. */
export function resetFormulaEditingForTests(): void {
  active = null;
  listeners.clear();
}
