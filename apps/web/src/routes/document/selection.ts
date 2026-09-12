/**
 * Selection types for the document route. The state machine itself lives in
 * `apps/web/src/doc/selection.ts`; this module re-exports it so the shell,
 * inspector and menus share one definition.
 */
export {
  IDLE,
  nextCell,
  reduce,
  sameCell,
  selectedCell,
  type CellSelection,
  type Direction,
  type EditSeed,
  type Editing,
  type GridEffect,
  type GridEvent,
  type GridState,
  type MoveResult,
  type Selection,
  type Transition,
  type TraversalTable,
} from '../../doc/selection.js';
