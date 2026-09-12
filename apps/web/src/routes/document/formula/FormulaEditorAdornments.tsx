import { useImperativeHandle, type Ref } from 'react';

import {
  useFormulaAdornments,
  type FormulaAdornments,
  type FormulaAdornmentsOptions,
} from './use-formula-adornments.js';

export type FormulaEditorAdornmentsHandle = Pick<
  FormulaAdornments,
  'onKeyDown' | 'onCellClickWhileEditing' | 'open' | 'inputProps'
>;

export interface FormulaEditorAdornmentsProps extends FormulaAdornmentsOptions {
  ref?: Ref<FormulaEditorAdornmentsHandle> | undefined;
}

/**
 * Component form of `useFormulaAdornments` for hosts that prefer JSX plus a
 * handle: render it beside the editor, call `handle.onKeyDown(e)` first in
 * the editor's keydown and `handle.onCellClickWhileEditing(address)` when a
 * cell is clicked mid-edit. The hook is the same contract without the ref
 * and is the better fit when the host also wants `inputProps` on its textarea.
 */
export function FormulaEditorAdornments({ ref, ...options }: FormulaEditorAdornmentsProps) {
  const adornments = useFormulaAdornments(options);
  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: adornments.onKeyDown,
      onCellClickWhileEditing: adornments.onCellClickWhileEditing,
      open: adornments.open,
      inputProps: adornments.inputProps,
    }),
    [
      adornments.onKeyDown,
      adornments.onCellClickWhileEditing,
      adornments.open,
      adornments.inputProps,
    ],
  );
  return adornments.element;
}
