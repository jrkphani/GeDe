import { useEffect, useRef, useState } from 'react';
import { baseKeymap, splitBlock } from 'prosemirror-commands';
import { history, redo as historyRedo, undo as historyUndo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { AllSelection, EditorState, Plugin, TextSelection, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import {
  detectIndicLang,
  fragmentToRich,
  isRichDoc,
  normalise,
  plainText,
  richFromText,
  type MarkName,
  type RichDoc,
  type TableMap,
} from '@gede/core';
import {
  initProseMirrorDoc,
  redo as yRedo,
  undo as yUndo,
  yUndoPlugin,
  yUndoPluginKey,
  ySyncPlugin,
  ySyncPluginKey,
} from 'y-prosemirror';
import type * as Y from 'yjs';

import type { CellSelection, Direction, EditSeed } from '../../../doc/selection.js';
import { isApplePlatform, matchesChord } from '../../../doc/shortcuts.js';
import { registerFormulaEditor, updateFormulaEditor } from '../formula/editing-store.js';
import { isFormulaInput } from '../formula/input.js';
import { useFormulaAdornments, type KeyLike } from '../formula/use-formula-adornments.js';
import { activeMarks, markForKey, toggleCellMark } from './marks.js';
import { editorSchema } from './schema.js';

export interface RichCellEditorProps {
  /** The cell's text as the grid shows it — formula source or plain text; the seed decides whether the editor starts from it. */
  initial: string;
  /** GRID-04: `existing` edits the text in place; `overwrite` starts from the typed character. */
  seed: EditSeed;
  address: string | undefined;
  /** Plain-text result and where the selection goes next (Enter down, Tab right, blur nowhere). Called once. */
  onCommit: (value: string, then: Direction | null) => void;
  onCancel: () => void;
  /**
   * The cell's live `Y.XmlFragment`. When given, the editor binds to it through
   * y-prosemirror: keystrokes and marks merge at character level as they happen
   * (optimistic, never blocked by sync). Without it the editor works on `initial`
   * alone and hands the rich result to `onCommitRich`.
   */
  fragment?: Y.XmlFragment | null | undefined;
  /**
   * The document's undo manager (KEYS-03). With it, everything this editor writes
   * to the fragment is one step on the document-level stack: ⌘Z inside the editor
   * and ⌘Z after commit agree, and Escape undoes back to the depth at open. Without
   * it the editor keeps a private stack for the life of the edit.
   */
  undoManager?: Y.UndoManager | null | undefined;
  /** Rich result of a detached edit (no `fragment`), alongside `onCommit`. */
  onCommitRich?: ((doc: RichDoc) => void) | undefined;
  /** Marks at the selection, for the Text tab (INSP-06). */
  onSelectionMarks?: ((marks: ReadonlySet<MarkName>) => void) | undefined;
  /** The active locale's language tag, the editor's `lang` unless the text is Indic (I18N-03). */
  locale?: string | undefined;
  /**
   * The table and cell being edited. The formula adornments (FX-02, FX-04,
   * FX-05) read the column's format, the workbook's `@` index and the lattice
   * from the table; the cell identifies the draft to the outlines layer. A
   * detached host (no table) gets a plain rich editor.
   */
  table?: TableMap | null | undefined;
  cell?: CellSelection | null | undefined;
}

/** The draft as the formula adornments see it: plain text and a caret in it. */
interface Draft {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** Offsets in the plain text (paragraphs joined by one newline each). */
function draftOf(state: EditorState): Draft {
  const text = state.doc.textBetween(0, state.doc.content.size, '\n');
  return {
    text,
    start: state.doc.textBetween(0, state.selection.from, '\n').length,
    end: state.doc.textBetween(0, state.selection.to, '\n').length,
  };
}

function docFromText(text: string) {
  return editorSchema.nodeFromJSON(richFromText(text));
}

function richOf(state: EditorState): RichDoc {
  const json: unknown = state.doc.toJSON();
  return isRichDoc(json) ? normalise(json) : richFromText(state.doc.textContent);
}

const UNDO: Command = (state, dispatch) => historyUndo(state, dispatch);
const REDO: Command = (state, dispatch) => historyRedo(state, dispatch);

function arrowDirection(code: string): Direction | null {
  switch (code) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    default:
      return null;
  }
}

/** `lang` for the editable: the script the text is in, else the locale's language. */
function langFor(text: string, locale: string | undefined): string | null {
  return detectIndicLang(text) ?? (locale === undefined ? null : (locale.split('-')[0] ?? null));
}

/**
 * The rich cell editor: a ProseMirror view drawn as the cell, same contract
 * as the grid's `CellEditor` — Enter commits and moves down, Tab right, ⇧Tab
 * left, Escape cancels, blur commits in place, ⇧⏎ adds a line, arrows commit
 * when the edit began by typing, none of it mid-composition (GRID-04,
 * GRID-06, I18N-01) — plus inline marks on ⌘B ⌘I ⌘U ⇧⌘X ⌃⌘+ ⌃⌘− by physical
 * key (KEYS-05) and, given the cell's fragment, character-level merging
 * through y-prosemirror.
 */
export function RichCellEditor({
  initial,
  seed,
  address,
  onCommit,
  onCancel,
  fragment,
  undoManager,
  onCommitRich,
  onSelectionMarks,
  locale,
  table,
  cell,
}: RichCellEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const done = useRef(false);
  const mounted = useRef(false);

  // Formula entry (FX-02, FX-04, FX-05): the adornments follow the draft and write back
  // through a ProseMirror transaction, so a bound fragment stays in step with y-prosemirror.
  const [draft, setDraft] = useState<Draft>(() => {
    const text = seed.kind === 'overwrite' ? seed.text : initial;
    return { text, start: text.length, end: text.length };
  });
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const adornments = useFormulaAdornments({
    table: table ?? null,
    colId: cell?.colId ?? '',
    text: draft.text,
    selectionStart: draft.start,
    selectionEnd: draft.end,
    anchor,
    onReplace: ({ text, caret }) => {
      const view = viewRef.current;
      if (view === null) return;
      // One paragraph: the whole text is replaced and the caret lands after the insertion.
      const size = view.state.doc.content.size;
      const tr = view.state.tr.insertText(text, 1, Math.max(1, size - 1));
      tr.setSelection(TextSelection.create(tr.doc, Math.min(caret + 1, tr.doc.content.size - 1)));
      view.dispatch(tr);
      view.focus();
    },
  });
  const adornKeyDown: (e: KeyLike) => boolean = adornments.onKeyDown;
  const latest = useRef({
    onCommit,
    onCancel,
    onCommitRich,
    onSelectionMarks,
    locale,
    adornKeyDown,
  });
  latest.current = { onCommit, onCancel, onCommitRich, onSelectionMarks, locale, adornKeyDown };
  const insertRef = useRef(adornments.onCellClickWhileEditing);
  insertRef.current = adornments.onCellClickWhileEditing;
  // Publish the draft: outlines follow it (FX-08) and cell presses insert into it (FX-05).
  const handle = useRef({
    state: {
      tableId: cell?.tableId ?? '',
      rowId: cell?.rowId ?? '',
      colId: cell?.colId ?? '',
      draft: draft.text,
      formula: isFormulaInput(draft.text),
    },
    insert: (a: string) => {
      insertRef.current(a);
    },
  });
  const tableId = cell?.tableId;
  const rowId = cell?.rowId;
  const colId = cell?.colId;
  useEffect(
    () => (tableId === undefined ? undefined : registerFormulaEditor(handle.current)),
    [tableId],
  );
  useEffect(() => {
    if (tableId === undefined || rowId === undefined || colId === undefined) return;
    updateFormulaEditor(handle.current, {
      tableId,
      rowId,
      colId,
      draft: draft.text,
      formula: isFormulaInput(draft.text),
    });
  }, [tableId, rowId, colId, draft.text]);
  // The listbox ARIA lives on the editable itself; EditorView attributes are static, so set them here.
  useEffect(() => {
    const dom = viewRef.current?.dom;
    if (dom === undefined) return;
    const props = adornments.inputProps;
    dom.setAttribute('aria-autocomplete', props['aria-autocomplete']);
    for (const name of ['aria-controls', 'aria-activedescendant'] as const) {
      const value = props[name];
      if (value === undefined) dom.removeAttribute(name);
      else dom.setAttribute(name, value);
    }
  }, [adornments.inputProps]);

  useEffect(() => {
    const el = host.current;
    if (el === null) return undefined;
    mounted.current = true;
    done.current = false;
    const apple = isApplePlatform();
    const bound = fragment !== null && fragment !== undefined && fragment.doc !== null;
    const shared = bound && undoManager !== null && undoManager !== undefined ? undoManager : null;
    // KEYS-03: with the document's manager, this edit session is one undo step —
    // a new item at open (stopCapturing), then every keystroke merges into it.
    const depth = shared === null ? 0 : shared.undoStack.length;
    const captureTimeout = shared?.captureTimeout ?? 0;
    if (shared !== null) {
      shared.stopCapturing();
      shared.addTrackedOrigin(ySyncPluginKey);
      shared.captureTimeout = Number.MAX_SAFE_INTEGER;
    }
    const release = (): void => {
      if (shared === null) return;
      shared.captureTimeout = captureTimeout;
      shared.removeTrackedOrigin(ySyncPluginKey);
      shared.stopCapturing();
    };

    const finish = (then: Direction | null | 'cancel'): void => {
      if (done.current) return;
      done.current = true;
      const view = viewRef.current;
      if (view === null) return;
      if (then !== 'cancel') {
        const rich = bound ? fragmentToRich(fragment) : richOf(view.state);
        if (!bound) latest.current.onCommitRich?.(rich);
        // The commit's own write (a formula replacing the fragment, an emptied
        // cell deleted) lands while the session is still capturing, so it merges
        // into the same step as the keystrokes: one ⌘Z, one edit (KEYS-03).
        latest.current.onCommit(plainText(rich), then);
        release();
        return;
      }
      if (shared !== null) {
        // Escape undoes what this editor did, back to the depth at open; a
        // collaborator's concurrent edits to the same cell are theirs and stay.
        // The undone edit must not come back through ⌘⇧Z, so the redo stack goes —
        // only when there was something to undo: an untouched edit leaves the
        // redo history from before the editor opened alone.
        if (shared.undoStack.length > depth) {
          while (shared.undoStack.length > depth) shared.undo();
          shared.clear(false, true);
        }
      } else if (bound) {
        const manager = (
          yUndoPluginKey.getState(view.state) as { undoManager: Y.UndoManager } | undefined
        )?.undoManager;
        if (manager !== undefined) {
          manager.stopCapturing();
          while (manager.undoStack.length > 0) manager.undo();
        }
      }
      release();
      latest.current.onCancel();
    };

    const undoCommand: Command = (state, dispatch) => {
      if (shared !== null) {
        if (shared.undoStack.length <= depth) return false;
        shared.undo();
        return true;
      }
      return (bound ? yUndo : UNDO)(state, dispatch);
    };
    const redoCommand: Command = (state, dispatch) => {
      if (shared !== null) {
        if (shared.redoStack.length === 0) return false;
        shared.redo();
        return true;
      }
      return (bound ? yRedo : REDO)(state, dispatch);
    };

    const keys = new Plugin({
      props: {
        handleKeyDown(view, event) {
          // I18N-01: `keyCode === 229` is the legacy IME signal some engines still send.
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- required by the IME contract
          if (event.isComposing || event.keyCode === 229) return false;
          // ProseMirror also synthesises an Enter keydown from a DOM change that
          // looks like one (`readDOMChange`), composition or not, and that event
          // carries no `isComposing`. While the view is composing, swallow it so
          // nothing commits or splits mid-composition (GRID-06, I18N-01).
          if (view.composing) return event.code === 'Enter';
          // An open forms menu or @ list takes ↑ ↓ ⏎ ⇥ ⎋ first (KEYS-06: Escape closes it, then cancels).
          if (latest.current.adornKeyDown(event)) return true;
          const mod = event.metaKey || event.ctrlKey;
          if ((event.code === 'Enter' || event.code === 'NumpadEnter') && !mod && !event.altKey) {
            if (event.shiftKey) return splitBlock(view.state, view.dispatch);
            event.preventDefault();
            finish('down');
            return true;
          }
          if (event.code === 'Escape') {
            event.preventDefault();
            finish('cancel');
            return true;
          }
          if (event.code === 'Tab') {
            event.preventDefault();
            finish(event.shiftKey ? 'left' : 'right');
            return true;
          }
          const arrow = arrowDirection(event.code);
          if (arrow !== null) {
            // Caret movement inside an existing edit; a typed-over cell commits and moves, as in Numbers.
            if (seed.kind !== 'overwrite' || mod || event.altKey || event.shiftKey) return false;
            event.preventDefault();
            finish(arrow);
            return true;
          }
          const mark = markForKey(event, apple);
          if (mark !== null) {
            event.preventDefault();
            toggleCellMark(view, mark);
            return true;
          }
          if (matchesChord(event, { code: 'KeyZ', mod: true }, apple)) {
            event.preventDefault();
            return undoCommand(view.state, view.dispatch);
          }
          if (
            matchesChord(event, { code: 'KeyZ', mod: true, shift: true }, apple) ||
            matchesChord(event, { code: 'KeyY', mod: true }, apple)
          ) {
            event.preventDefault();
            return redoCommand(view.state, view.dispatch);
          }
          return false;
        },
        handleDOMEvents: {
          blur: () => {
            finish(null);
            return false;
          },
        },
      },
    });

    let state: EditorState;
    if (bound) {
      const { doc, mapping } = initProseMirrorDoc(fragment, editorSchema);
      state = EditorState.create({
        doc,
        plugins: [
          ySyncPlugin(fragment, { mapping }),
          ...(shared === null ? [yUndoPlugin()] : []),
          keys,
          keymap(baseKeymap),
        ],
      });
    } else {
      state = EditorState.create({
        doc: docFromText(seed.kind === 'overwrite' ? seed.text : initial),
        plugins: [history(), keys, keymap(baseKeymap)],
      });
    }

    const initialLang = langFor(seed.kind === 'overwrite' ? seed.text : initial, locale);
    const view = new EditorView(el, {
      state,
      attributes: {
        class: 'gd-rich-editor',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': address === undefined ? 'Cell' : `Edit ${address}`,
        spellcheck: 'false',
        ...(initialLang === null ? {} : { lang: initialLang }),
      },
      dispatchTransaction(tr) {
        const next = view.state.apply(tr);
        view.updateState(next);
        if (tr.docChanged || tr.selectionSet) setDraft(draftOf(next));
        if (tr.docChanged) {
          // I18N-03: the line-height rule follows the script as it is typed, not as it was opened.
          const lang = langFor(next.doc.textContent, latest.current.locale);
          if (lang === null) view.dom.removeAttribute('lang');
          else if (view.dom.getAttribute('lang') !== lang) view.dom.setAttribute('lang', lang);
        }
        if (tr.selectionSet || tr.docChanged || tr.storedMarksSet) {
          latest.current.onSelectionMarks?.(activeMarks(next));
        }
      },
    });
    viewRef.current = view;
    view.focus();
    if (bound && seed.kind === 'overwrite') {
      // GRID-04: typing replaces the cell — the typed character overwrites the whole text.
      view.dispatch(
        view.state.tr.setSelection(new AllSelection(view.state.doc)).insertText(seed.text),
      );
    } else {
      // Caret at the end: an edit appends to the text, an overwrite continues the word.
      view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    }
    latest.current.onSelectionMarks?.(activeMarks(view.state));

    // GRID-06: blur commits. Selecting another cell (or switching sheet) unmounts the
    // editor before the browser blurs it, so the draft commits here unless already
    // finished. Deferred one microtask so StrictMode's mount → unmount → mount rehearsal
    // (which remounts synchronously) does not commit.
    return () => {
      mounted.current = false;
      const current = viewRef.current;
      const pending =
        current !== null && !done.current
          ? bound
            ? fragmentToRich(fragment)
            : richOf(current.state)
          : null;
      current?.destroy();
      viewRef.current = null;
      if (!done.current) release();
      queueMicrotask(() => {
        if (mounted.current || done.current || pending === null) return;
        done.current = true;
        if (!bound) latest.current.onCommitRich?.(pending);
        latest.current.onCommit(plainText(pending), null);
      });
    };
    // The editor is created once per mount; props that change mid-edit are read through `latest`.
  }, []);

  return (
    <>
      <div
        ref={(el) => {
          host.current = el;
          setAnchor(el);
        }}
        className="gd-cell__editor gd-cell__editor--rich"
        onKeyDown={(e) => {
          // The editor owns its keys; the cell beneath must not see them.
          e.stopPropagation();
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
        }}
      />
      {adornments.element}
    </>
  );
}
