import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  isSummable,
  readString,
  searchEntities,
  type EntityEntry,
  type Id,
  type TableMap,
} from '@gede/core';
import { Icon, Popover } from '@gede/ui';

import { useYVersion } from '../../../doc/use-y.js';
import { useWorkbookIndexVersion, workbookIndexFor } from '../../../doc/workbook-index.js';
import {
  entityQueryAt,
  insertReferenceAt,
  isBareEquals,
  isFormulaInput,
  replaceRange,
  type Replacement,
} from './input.js';
import { columnFormatOf, docOf } from './workbook.js';

export interface FormulaAdornmentsOptions {
  /** The table and column of the cell being edited (FX-02: Sum is offered per column format). */
  table: TableMap;
  colId: Id;
  /** The editor's draft and selection, straight from the textarea. */
  text: string;
  selectionStart: number;
  selectionEnd: number;
  /** The editor element the popovers anchor to. */
  anchor: Element | null;
  /** The host writes the new draft and moves the caret; the editor stays open. */
  onReplace: (replacement: Replacement) => void;
  /** False while the cell is not editable or the editor is closed. */
  enabled?: boolean | undefined;
}

/** A keyboard event as the host sees it; shortcuts resolve from `code`, never `key` (KEYS). */
export interface KeyLike {
  readonly code: string;
  readonly isComposing?: boolean | undefined;
  /** I18N-01: `229` is the legacy IME signal some engines still send. */
  readonly keyCode?: number | undefined;
  preventDefault(): void;
}

export interface FormulaAdornments {
  /** Render this next to the editor (it portals its own surfaces). */
  readonly element: ReactNode;
  /** Call first in the editor's keydown; true means the key was consumed (↑ ↓ ⏎ ⇥ ⎋ while a surface is open). */
  readonly onKeyDown: (e: KeyLike) => boolean;
  /** FX-05: another cell was clicked while editing; its address goes in at the caret. */
  readonly onCellClickWhileEditing: (address: string) => void;
  /**
   * Spread onto the textarea so assistive tech knows a listbox is driving it.
   * No `aria-expanded`: it is not permitted on the textbox role (axe
   * `aria-allowed-attr`, critical); `aria-controls` being set is the open signal.
   */
  readonly inputProps: {
    readonly 'aria-autocomplete': 'list';
    readonly 'aria-controls': string | undefined;
    readonly 'aria-activedescendant': string | undefined;
  };
  readonly open: 'forms' | 'entities' | null;
}

interface FormOption {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly insert: string;
  readonly disabledReason?: string | undefined;
}

const SUM_DISABLED = 'Sum is offered on Number or Currency columns';

function forms(summable: boolean): FormOption[] {
  return [
    { id: 'concat', label: 'Concat(a, b, …)', hint: 'joins values end to end', insert: '=Concat(' },
    {
      id: 'sum',
      label: 'Sum(B2:B14)',
      hint: 'adds a range, list, column or @ paths',
      insert: '=Sum(',
      disabledReason: summable ? undefined : SUM_DISABLED,
    },
    {
      id: 'entity',
      label: '@Group.Entity',
      hint: 'a value from anywhere in the workscape',
      insert: '=@',
    },
  ];
}

/**
 * Formula entry adornments for a cell editor (PRD §13; FX-02, FX-04, FX-05):
 * the menu of forms when the draft is `=`, the `@` entity autocomplete at the
 * caret, and click-to-insert. Neither surface takes focus from the editor;
 * the host forwards keys through `onKeyDown`.
 */
export function useFormulaAdornments(options: FormulaAdornmentsOptions): FormulaAdornments {
  const { table, colId, text, selectionStart, selectionEnd, anchor, onReplace } = options;
  const enabled = options.enabled ?? true;
  const doc = docOf(table);
  // The column's cells decide whether Sum is offered; the workbook's labels feed the @ index.
  const version = useYVersion(table);
  const indexVersion = useWorkbookIndexVersion(doc);
  const listboxId = useId();
  const [highlighted, setHighlighted] = useState(0);
  /** The draft the person dismissed with Escape; the same draft does not reopen. */
  const [dismissed, setDismissed] = useState<string | null>(null);
  const latest = useRef({ text, selectionStart, selectionEnd, onReplace });
  latest.current = { text, selectionStart, selectionEnd, onReplace };

  const summable = useMemo(
    () => isSummable(columnFormatOf(table, colId)),
    // version: the column's cells changed.
    [table, colId, version],
  );
  const entityQuery = enabled ? entityQueryAt(text, selectionStart) : null;
  const showForms = enabled && isBareEquals(text) && dismissed !== text;
  const showEntities = entityQuery !== null && dismissed !== text && isFormulaInput(text);

  const formOptions = useMemo(() => forms(summable), [summable]);
  const entities = useMemo<readonly EntityEntry[]>(
    () =>
      showEntities ? searchEntities(workbookIndexFor(doc).entityIndex(), entityQuery.query) : [],
    // indexVersion: labels or tables changed; the index itself is cached per document.
    [doc, showEntities, entityQuery?.query, indexVersion],
  );

  const open: 'forms' | 'entities' | null = showForms
    ? 'forms'
    : showEntities && entities.length > 0
      ? 'entities'
      : null;
  const count = open === 'forms' ? formOptions.length : open === 'entities' ? entities.length : 0;

  useEffect(() => {
    setHighlighted(0);
  }, [open, entityQuery?.query]);

  const pick = useCallback(
    (index: number) => {
      const current = latest.current;
      let replacement: Replacement | null = null;
      if (open === 'forms') {
        const option = formOptions[index];
        if (option === undefined || option.disabledReason !== undefined) return;
        replacement = replaceRange(current.text, 0, current.text.length, option.insert);
      } else if (open === 'entities') {
        const entry = entities[index];
        const q = entityQueryAt(current.text, current.selectionStart);
        if (entry === undefined || q === null) return;
        replacement = replaceRange(current.text, q.start, current.selectionStart, entry.text);
      }
      if (replacement === null) return;
      // The surface closes on pick; typing on (a `.`, a `,`) reopens it for the new draft.
      setDismissed(replacement.text);
      current.onReplace(replacement);
    },
    [open, formOptions, entities],
  );

  const onKeyDown = useCallback(
    (e: KeyLike): boolean => {
      if (open === null || e.isComposing === true || e.keyCode === 229) return false;
      switch (e.code) {
        case 'ArrowDown':
          e.preventDefault();
          setHighlighted((h) => (h + 1) % Math.max(1, count));
          return true;
        case 'ArrowUp':
          e.preventDefault();
          setHighlighted((h) => (h - 1 + Math.max(1, count)) % Math.max(1, count));
          return true;
        case 'Enter':
        case 'NumpadEnter':
        case 'Tab':
          e.preventDefault();
          pick(highlighted);
          return true;
        case 'Escape':
          e.preventDefault();
          setDismissed(latest.current.text);
          return true;
        default:
          return false;
      }
    },
    [open, count, highlighted, pick],
  );

  const onCellClickWhileEditing = useCallback((address: string) => {
    const current = latest.current;
    if (!isFormulaInput(current.text)) return;
    current.onReplace(
      insertReferenceAt(current.text, current.selectionStart, current.selectionEnd, address),
    );
  }, []);

  const activeId = open === null ? undefined : `${listboxId}-${String(highlighted)}`;
  const tableTitle = readString(table, 'title');

  const element: ReactNode = (
    <Popover
      open={open !== null}
      onOpenChange={(next) => {
        if (!next) setDismissed(latest.current.text);
      }}
      anchor={anchor}
      label={open === 'forms' ? 'Formula forms' : 'Entities'}
      className="gd-formula-popover"
    >
      {open === 'forms' && (
        <div role="listbox" id={listboxId} aria-label="Formula forms" className="gd-formula-list">
          {formOptions.map((o, i) => (
            <div
              key={o.id}
              id={`${listboxId}-${String(i)}`}
              role="option"
              aria-selected={i === highlighted}
              aria-disabled={o.disabledReason !== undefined || undefined}
              title={o.disabledReason}
              className="gd-formula-option"
              onMouseDown={(e) => {
                e.preventDefault(); // keep the editor's focus
              }}
              onMouseEnter={() => {
                setHighlighted(i);
              }}
              onClick={() => {
                pick(i);
              }}
            >
              <Icon name={o.id === 'entity' ? 'reference' : 'formula'} size={13} />
              <span className="gd-mono gd-formula-option__label">{o.label}</span>
              <span className="gd-formula-option__hint">{o.disabledReason ?? o.hint}</span>
            </div>
          ))}
        </div>
      )}
      {open === 'entities' && (
        <div role="listbox" id={listboxId} aria-label="Entities" className="gd-formula-list">
          {entities.map((entry, i) => (
            <div
              key={entry.cellId}
              id={`${listboxId}-${String(i)}`}
              role="option"
              aria-selected={i === highlighted}
              className="gd-formula-option"
              onMouseDown={(e) => {
                e.preventDefault();
              }}
              onMouseEnter={() => {
                setHighlighted(i);
              }}
              onClick={() => {
                pick(i);
              }}
            >
              <Icon name="reference" size={13} />
              <span className="gd-mono gd-formula-option__label">{entry.text}</span>
              {entry.path[0] !== tableTitle && (
                <span className="gd-formula-option__hint">{entry.path[0]}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </Popover>
  );

  return {
    element,
    onKeyDown,
    onCellClickWhileEditing,
    inputProps: {
      'aria-autocomplete': 'list',
      'aria-controls': open === null ? undefined : listboxId,
      'aria-activedescendant': activeId,
    },
    open,
  };
}
