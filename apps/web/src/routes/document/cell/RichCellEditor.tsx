import { useEffect, useRef } from 'react';
import { baseKeymap, splitBlock } from 'prosemirror-commands';
import { history, redo as historyRedo, undo as historyUndo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { AllSelection, EditorState, Plugin, type Command } from 'prosemirror-state';
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
} from '@gede/core';
import {
  initProseMirrorDoc,
  redo as yRedo,
  undo as yUndo,
  yUndoPlugin,
  yUndoPluginKey,
  ySyncPlugin,
} from 'y-prosemirror';
import type * as Y from 'yjs';

import { isApplePlatform, matchesChord } from '../../../doc/shortcuts.js';
import { activeMarks, markForKey, toggleCellMark } from './marks.js';
import { editorSchema } from './schema.js';

export interface RichCellEditorProps {
  /** The cell's text as the grid shows it — formula source or plain text (Wave 1 contract). */
  initial: string;
  address: string | undefined;
  /** Plain-text result; the grid's `setCellText` path. Called once, on commit. */
  onCommit: (value: string) => void;
  onCancel: () => void;
  /**
   * The cell's live `Y.XmlFragment`. When given, the editor binds to it through
   * y-prosemirror: keystrokes and marks merge at character level as they happen
   * (optimistic, never blocked by sync), and Escape undoes this editor's own
   * edits. Without it the editor works on `initial` alone and hands the rich
   * result to `onCommitRich`.
   */
  fragment?: Y.XmlFragment | null | undefined;
  /** Rich result of a detached edit (no `fragment`), alongside `onCommit`. */
  onCommitRich?: ((doc: RichDoc) => void) | undefined;
  /** Marks at the selection, for the Text tab (INSP-06). */
  onSelectionMarks?: ((marks: ReadonlySet<MarkName>) => void) | undefined;
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

/**
 * The rich cell editor: a ProseMirror view drawn as the cell, same contract
 * as the Wave 1 `CellEditor` — Enter commits, Escape cancels, Tab commits,
 * blur commits, ⇧⏎ adds a line, none of it mid-composition (GRID-06,
 * I18N-01) — plus inline marks on ⌘B ⌘I ⌘U ⇧⌘X ⌃⌘+ ⌃⌘− by physical key
 * (KEYS-05) and, given the cell's fragment, character-level merging through
 * y-prosemirror.
 */
export function RichCellEditor({
  initial,
  address,
  onCommit,
  onCancel,
  fragment,
  onCommitRich,
  onSelectionMarks,
}: RichCellEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const done = useRef(false);
  const mounted = useRef(false);
  const latest = useRef({ onCommit, onCancel, onCommitRich, onSelectionMarks });
  latest.current = { onCommit, onCancel, onCommitRich, onSelectionMarks };
  const lang = detectIndicLang(initial);

  useEffect(() => {
    const el = host.current;
    if (el === null) return undefined;
    mounted.current = true;
    done.current = false;
    const apple = isApplePlatform();
    const bound = fragment !== null && fragment !== undefined && fragment.doc !== null;

    const finish = (commit: boolean): void => {
      if (done.current) return;
      done.current = true;
      const view = viewRef.current;
      if (view === null) return;
      if (commit) {
        const rich = bound ? fragmentToRich(fragment) : richOf(view.state);
        if (!bound) latest.current.onCommitRich?.(rich);
        latest.current.onCommit(plainText(rich));
      } else {
        if (bound) {
          // Escape undoes what this editor did to the fragment; a collaborator's
          // concurrent edits to the same cell are theirs and stay.
          const manager = (
            yUndoPluginKey.getState(view.state) as { undoManager: Y.UndoManager } | undefined
          )?.undoManager;
          if (manager !== undefined) {
            manager.stopCapturing();
            while (manager.undoStack.length > 0) manager.undo();
          }
        }
        latest.current.onCancel();
      }
    };

    const keys = new Plugin({
      props: {
        handleKeyDown(view, event) {
          // I18N-01: `keyCode === 229` is the legacy IME signal some engines still send.
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- required by the IME contract
          if (event.isComposing || event.keyCode === 229) return false;
          if (event.code === 'Enter' && !event.shiftKey && !event.altKey) {
            event.preventDefault();
            finish(true);
            return true;
          }
          if (event.code === 'Enter' && event.shiftKey) {
            return splitBlock(view.state, view.dispatch);
          }
          if (event.code === 'Escape') {
            event.preventDefault();
            finish(false);
            return true;
          }
          if (event.code === 'Tab') {
            event.preventDefault();
            finish(true);
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
            return (bound ? yUndo : UNDO)(view.state, view.dispatch);
          }
          if (
            matchesChord(event, { code: 'KeyZ', mod: true, shift: true }, apple) ||
            matchesChord(event, { code: 'KeyY', mod: true }, apple)
          ) {
            event.preventDefault();
            return (bound ? yRedo : REDO)(view.state, view.dispatch);
          }
          return false;
        },
        handleDOMEvents: {
          blur: () => {
            finish(true);
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
        plugins: [ySyncPlugin(fragment, { mapping }), yUndoPlugin(), keys, keymap(baseKeymap)],
      });
    } else {
      state = EditorState.create({
        doc: docFromText(initial),
        plugins: [history(), keys, keymap(baseKeymap)],
      });
    }
    // Like the Wave 1 textarea's `select()`: typing replaces the whole cell.
    state = state.apply(state.tr.setSelection(new AllSelection(state.doc)));

    const view = new EditorView(el, {
      state,
      attributes: {
        class: 'gd-rich-editor',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': address === undefined ? 'Cell' : `Edit ${address}`,
        spellcheck: 'false',
        ...(lang === null ? {} : { lang }),
      },
      dispatchTransaction(tr) {
        const next = view.state.apply(tr);
        view.updateState(next);
        if (tr.selectionSet || tr.docChanged || tr.storedMarksSet) {
          latest.current.onSelectionMarks?.(activeMarks(next));
        }
      },
    });
    viewRef.current = view;
    view.focus();
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
      queueMicrotask(() => {
        if (mounted.current || done.current || pending === null) return;
        done.current = true;
        if (!bound) latest.current.onCommitRich?.(pending);
        latest.current.onCommit(plainText(pending));
      });
    };
    // The editor is created once per mount; props that change mid-edit are read through `latest`.
  }, []);

  return (
    <div
      ref={host}
      className="gd-cell__editor gd-cell__editor--rich"
      onKeyDown={(e) => {
        // The editor owns its keys; the cell beneath must not see them.
        e.stopPropagation();
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
      }}
    />
  );
}
