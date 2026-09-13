import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  cellAddress,
  cellRich,
  createSheet,
  createTable,
  deleteSheet,
  graphById,
  graphsOnSheet,
  isLastSheet,
  LATTICE,
  listSheets,
  renameSheet,
  sheetBounds,
  sheetEdgesShown,
  tableById,
  tableMap,
  tablesOnSheet,
  tableUnitBounds,
  toggleMarkThroughout,
  toPresenceState,
  unitBoundsToPx,
  type GedeDoc,
  type Id,
  type PresenceState,
  type SheetRecord,
  type ToggleMark,
} from '@gede/core';
import { atLeast, theme } from '@gede/tokens';
import { Banner, Button, Skeleton, Toast, useLoadingTiers, type LoadingTiers } from '@gede/ui';

import { announce } from '../../announce.js';
import { getDocument, permissionOf, type DocumentSummary } from '../../api/documents.js';
import { signOutLocal } from '../../auth/cognito.js';
import { rememberReturnTo, useSession } from '../../auth/session.js';
import { ApiError } from '../../api/client.js';
import { usePresenceColour } from '../../doc/presence.js';
import { rememberLastDocument } from '../../last-document.js';
import { useShortcuts } from '../../doc/shortcuts.js';
import {
  CLOSE_FORBIDDEN,
  CLOSE_MESSAGE_TOO_BIG,
  CLOSE_NOT_FOUND,
  CLOSE_TOO_LARGE,
  CLOSE_UNAUTHENTICATED,
  type SyncFailure,
  type SyncSnapshot,
} from '../../doc/sync-client.js';
import { useDocument, type DocumentSession, type ReplicaState } from '../../doc/use-document.js';
import { useAwarenessVersion, useYVersion } from '../../doc/use-y.js';
import {
  centre,
  clampViewport,
  fitViewport,
  INITIAL_VIEWPORT,
  revealBounds,
  visibleRange,
  ZOOM_STEP,
  zoomBy,
  zoomTier,
  zoomTo,
  type Size,
  type Viewport,
} from '../../doc/viewport.js';
import { peekEngine } from '../../doc/engine.js';
import { LABELS } from '../../doc/shortcuts.js';
import { translate } from '../../i18n/index.js';
import { formatNumber } from '../../intl.js';
import { activeLocale, useLocale } from '../../locale.js';
import { usePhone } from '../../breakpoint.js';
import { useMediaQuery } from '../../use-media-query.js';
import { Canvas } from './Canvas.js';
import { toFormatLocale } from './cell/index.js';
import { FindBar } from './find/FindBar.js';
import { MatchHighlights } from './find/MatchHighlights.js';
import { matchBounds } from './find/match-geometry.js';
import { useFind, type FindNavigation } from './find/useFind.js';
import { FormulaEngineBanner, FormulaLayer } from './formula/index.js'; // wave2/formulas mount points
import { pinnedPanelOffset } from './grid/pinned.js';
import { DocumentMenu } from './grid/DocumentMenu.js';
import { TableMenu } from './grid/TableMenu.js';
import { useGrid } from './grid/use-grid.js';
import { DerivePanel } from './ref/index.js'; // wave3/references
import { GraphLayer, GraphTab, useGraphs } from './graph/index.js'; // wave4/graphs
import { SortPanel, useSortCommands } from './sort/index.js';
import {
  NULL_VIEW_STORE,
  openViewStore,
  useViewStore,
  ViewStoreProvider,
} from '../../doc/view-state.js';
import { Inspector, type OrganizeTab } from './Inspector.js';
import type { HeadObject } from './inspector/InspectorHead.js';
import { documentBindings } from './keys/bindings.js';
import type { CellSelection } from './selection.js';
import { useCellClipboard } from './keys/clipboard.js';
import {
  currentObject,
  objectBounds,
  objectElement,
  objectEntry,
  sheetObjects,
  stepObject,
  tableEntry,
  type SheetObject,
} from './keys/objects.js';
import { setTourDocument } from '../tour/store.js';
import { useTourGraphSubstep } from '../tour/use-tour.js';
import { ShortcutSheet } from './keys/ShortcutSheet.js';
import { DocumentContextMenu } from './menus/DocumentContextMenu.js';
import type { MenuContext } from './menus/entries.js';
import { SheetTabs, type SheetEditing } from './SheetTabs.js';
import {
  deletedSheetAnnouncement,
  deletedSheetTitle,
  lastSheetAnnouncement,
  neighbourSheet,
  remoteSheetRemovedAnnouncement,
  renamedSheetAnnouncement,
  restoredSheetAnnouncement,
  sheetName,
} from './sheets.js';
import { TableView } from './TableView.js';
import { DagEdges, useFitter, useTableFlags } from './style/index.js'; // wave4/inspector-controls
import { SAMPLE_RENAME_REASON, TitleBar } from './TitleBar.js';
import { ShareControls } from './share/ShareControls.js';
import { Toolbar, type InspectorMode } from './Toolbar.js';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; document: DocumentSummary }
  | { status: 'error'; error: unknown };

/** Fit padding and "reveal" margin, from the space scale (space-4 = 16 px). */
const FIT_PADDING = theme.space[4];

/**
 * Document shell (DOC-01..07). Loads the REST record (title, permission),
 * opens the Yjs document, then renders the chrome around the canvas. Below
 * 768 px the product is read-only (RESP-02); a view-only participant is
 * read-only at every width (SHARE-03).
 */
/** A ghost carries no collaborator tags (INSP-07): the live, pinned copy does. */
const NO_PRESENCE: readonly PresenceState[] = [];

export function DocumentShell() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const phone = usePhone(); // RESP-02 with the fine-pointer exception (ADR-039)
  const { state: sessionState } = useSession();
  const userSub = sessionState.status === 'signed-in' ? sessionState.user.sub : null;
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    setLoad({ status: 'loading' });
    getDocument(id)
      .then((document) => {
        setLoad({ status: 'ready', document });
        rememberLastDocument({ id: document.id, title: document.title });
        announce(`Opened ${document.title}`);
      })
      .catch((error: unknown) => {
        setLoad({ status: 'error', error });
      });
  }, [id]);

  const doc = load.status === 'ready' ? load.document : null;
  const seed = useMemo(
    () => (doc === null ? null : { title: doc.title, createdAt: doc.createdAt }),
    [doc],
  );
  const { session, sync, ready, replica } = useDocument(id, { seed, userSub });
  // ADR-026: the viewer's table views, per (user, document), on this device; nothing
  // without a signed-in user.
  const viewStore = useMemo(
    () => (userSub === null ? NULL_VIEW_STORE : openViewStore(userSub, id)),
    [userSub, id],
  );
  // One timer spans the REST record and the replica, so the 400 ms hold is one hold (LOAD-02).
  const tiers = useLoadingTiers(doc === null || session === null || !ready);

  if (load.status === 'error') throw load.error;
  // A deliberate refusal before anything rendered is a full page, not a permanent skeleton:
  // 4401 → the session page (path retained), 4403 → no access, 4404 → nothing at this address.
  if (!ready && sync.failure !== null && isCatalogueClose(sync.failure)) {
    throw new ApiError(sync.failure.code - 4000, sync.failure.reason, undefined);
  }

  const editable = !phone && doc !== null && permissionOf(doc) !== 'view' && !sync.readOnly;
  const statusLabel = doc === null ? 'Loading workscape' : `Loading ${doc.title}`;

  if (doc === null || session === null) {
    return (
      <div className={clsx('gd-doc', { 'gd-doc--phone': phone })}>
        <div className="gd-doc__loading">
          <Skeleton
            active
            tiers={tiers}
            rows={8}
            statusLabel={statusLabel}
            className="gd-doc__skeleton"
          />
        </div>
      </div>
    );
  }

  return (
    <ViewStoreProvider value={viewStore}>
      <OpenDocument
        key={session.docId}
        doc={doc}
        session={session}
        sync={sync}
        ready={ready}
        tiers={tiers}
        replica={replica}
        phone={phone}
        editable={editable}
        focusTitle={params.get('new') === '1'}
      />
    </ViewStoreProvider>
  );
}

/** Server closes that mirror an HTTP status the error catalogue has a page for. */
function isCatalogueClose(failure: SyncFailure): boolean {
  if (failure.local === true) return false; // no token on this device: the session provider's call
  const { code } = failure;
  return code === CLOSE_UNAUTHENTICATED || code === CLOSE_FORBIDDEN || code === CLOSE_NOT_FOUND;
}

interface OpenDocumentProps {
  doc: DocumentSummary;
  session: DocumentSession;
  sync: SyncSnapshot;
  ready: boolean;
  tiers: LoadingTiers;
  replica: ReplicaState;
  phone: boolean;
  editable: boolean;
  focusTitle: boolean;
}

function OpenDocument({
  doc,
  session,
  sync,
  ready,
  tiers,
  replica,
  phone,
  editable,
  focusTitle,
}: OpenDocumentProps) {
  const { gd } = session;
  const { state: sessionState } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const wide = useMediaQuery(atLeast('inspector'));
  // The shell watches structure only (sheets and objects added or removed); each
  // TableView watches its own map deeply, so a cell edit re-renders one table.
  useYVersion(gd.sheets); // deep: a sheet label lives in a nested map
  useYVersion(gd.tables, { depth: 'shallow' });
  useTableFlags(gd); // INSP-07: `pinned` and `z` decide the layers below; nothing else inside a table
  useYVersion(gd.graphs, { depth: 'shallow' });
  const awarenessVersion = useAwarenessVersion(session.sync.awareness);
  // ONB-05: the guided tour reads this document for its step-2 and step-3 checks —
  // once it has loaded, so the counts it takes as its baseline are the document's, not
  // an empty replica's.
  useEffect(() => {
    if (!ready) return;
    setTourDocument(gd);
    return () => {
      setTourDocument(null);
    };
  }, [gd, ready]);

  // Viewer state (never document state): active sheet, selection, viewport, chrome toggles.
  const sheets = listSheets(gd);
  const [chosenSheetId, setChosenSheetId] = useState<Id | null>(null);
  // The strip as it last rendered, so a sheet that has just gone (a collaborator deleted
  // it, a redo did) still names its neighbour (ADR-048).
  const lastSheets = useRef<readonly SheetRecord[]>(sheets);
  const chosenPresent = chosenSheetId !== null && sheets.some((s) => s.id === chosenSheetId);
  const activeSheetId = chosenPresent
    ? chosenSheetId
    : chosenSheetId === null
      ? (sheets[0]?.id ?? null)
      : (neighbourSheet(lastSheets.current, sheets, chosenSheetId)?.id ?? null);
  // ADR-049: this replica measures wrapped rows and stores their heights (R-B).
  const fitter = useFitter(gd.doc);
  // Selection, editing and traversal (GRID-03..06) live in the grid state machine.
  const grid = useGrid(gd, editable, { undo: session.undo, fit: fitter.fit });
  // SORT-01..06 (ADR-026): the viewer's own sort, filter and grouping per table, from the
  // store the shell mounted above; never document state.
  const sort = useSortCommands(gd, useViewStore());
  const { selection, editing } = grid.state;
  const [viewport, setViewport] = useState<Viewport>(INITIAL_VIEWPORT);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [gridlines, setGridlines] = useState(true);
  // INSP-02 / RESP-04: the rail is always present above phone width — docked at 322 px or
  // collapsed to a 38 px strip. It starts open from 1200 px and collapsed below.
  const [inspectorMode, setInspectorMode] = useState<InspectorMode>('format');
  const [organizeTab, setOrganizeTab] = useState<OrganizeTab>('categories');
  const [inspectorOpen, setInspectorOpen] = useState(() => wide);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [activeLocale] = useLocale();
  const locale = toFormatLocale(activeLocale);

  const tables = activeSheetId === null ? [] : tablesOnSheet(gd, activeSheetId);
  const selectedTable = selection === null ? null : tableById(gd, selection.tableId);
  const cell = grid.cell;
  const tier = zoomTier(viewport.zoom);

  // -- presence ---------------------------------------------------------------
  // Assigned once the room has answered (first sync or first remote state), re-picked on collision.
  const colour = usePresenceColour(session.sync.awareness, sync.everSynced);
  const others = useMemo(() => {
    const list: PresenceState[] = [];
    session.sync.awareness.getStates().forEach((state, clientId) => {
      if (clientId === gd.doc.clientID) return;
      const p = toPresenceState(state);
      if (p !== null) list.push(p);
    });
    return list;
    // awarenessVersion is the change signal for the awareness map read above.
  }, [session, gd, awarenessVersion]);
  const user = sessionState.status === 'signed-in' ? sessionState.user : null;
  useEffect(() => {
    if (user === null || colour === null) return;
    const state: PresenceState = {
      userId: user.sub,
      name: user.name ?? user.email,
      colour,
      sheetId: activeSheetId,
      cell: cell ?? undefined,
    };
    session.sync.awareness.setLocalState(state);
  }, [session, user, colour, activeSheetId, cell?.tableId, cell?.rowId, cell?.colId]);
  const onSheet = useMemo(
    () => others.filter((o) => o.sheetId === activeSheetId),
    [others, activeSheetId],
  );

  // -- selection --------------------------------------------------------------
  const { clear: clearSelection } = grid.actions;

  // -- sheets (DOC-03) --------------------------------------------------------
  /** Show a sheet: swap the canvas, clear the selection, back to A1 (DOC-03). Says nothing. */
  const showSheet = useCallback(
    (sheetId: Id) => {
      setChosenSheetId(sheetId);
      clearSelection();
      setViewport((v) => ({ x: 0, y: 0, zoom: v.zoom }));
    },
    [clearSelection],
  );
  const selectSheet = useCallback(
    (sheetId: Id) => {
      showSheet(sheetId);
      const sheet = listSheets(gd).find((s) => s.id === sheetId);
      // A sheet still named by its ordinal ("Sheet 2") is announced once, not "Sheet 2, Sheet 2" (#142).
      if (sheet !== undefined) announce(sheetName(sheet));
    },
    [gd, showSheet],
  );
  const appendSheet = useCallback(() => {
    const id = createSheet(gd);
    selectSheet(id);
  }, [gd, selectSheet]);
  // ADR-048 / #165: the tab's commands. Rename is an inline field on the tab; delete goes
  // straight through with an Undo toast (LIB-D9, ADR-031) and one announcement; the last
  // sheet stays. The toast's Undo reverses exactly the deletion, so it lives only while that
  // is the latest local step: the next local step, or an undo, dismisses it.
  const [renamingSheetId, setRenamingSheetId] = useState<Id | null>(null);
  const [sheetNotice, setSheetNotice] = useState<{
    title: string;
    step: unknown;
    undo: () => void;
  } | null>(null);
  useEffect(() => {
    if (sheetNotice === null) return;
    const manager = session.undo;
    const check = () => {
      if (manager.undoStack.at(-1) !== sheetNotice.step) setSheetNotice(null);
    };
    manager.on('stack-item-added', check);
    manager.on('stack-item-popped', check);
    return () => {
      manager.off('stack-item-added', check);
      manager.off('stack-item-popped', check);
    };
  }, [session, sheetNotice]);
  const commitSheetRename = useCallback(
    (sheetId: Id, label: string): boolean => {
      const trimmed = label.trim();
      if (trimmed === '') return false;
      const was = listSheets(gd).find((s) => s.id === sheetId);
      session.undo.stopCapturing();
      const written = renameSheet(gd, sheetId, trimmed);
      session.undo.stopCapturing();
      setRenamingSheetId(null);
      if (written && was !== undefined) announce(renamedSheetAnnouncement(was.label, trimmed));
      return true;
    },
    [gd, session],
  );
  const removeSheet = useCallback(
    (sheetId: Id) => {
      if (isLastSheet(gd)) {
        announce(lastSheetAnnouncement());
        return;
      }
      if (listSheets(gd).every((s) => s.id !== sheetId)) return; // already gone
      const wasActive = sheetId === activeSheetId;
      session.undo.stopCapturing();
      const result = deleteSheet(gd, sheetId);
      session.undo.stopCapturing();
      const step: unknown = session.undo.undoStack.at(-1);
      const nowOn = listSheets(gd).find((s) => s.id === result.neighbourId) ?? null;
      if (wasActive) showSheet(result.neighbourId);
      announce(deletedSheetAnnouncement(result, wasActive ? nowOn : null));
      setSheetNotice({
        title: deletedSheetTitle(result),
        step,
        undo: () => {
          setSheetNotice(null);
          if (session.undo.undoStack.at(-1) !== step) return;
          session.undo.undo();
          showSheet(sheetId);
          const restored = listSheets(gd).find((s) => s.id === sheetId);
          if (restored !== undefined) announce(restoredSheetAnnouncement(restored));
        },
      });
    },
    [gd, session, activeSheetId, showSheet],
  );
  const sheetEditing: SheetEditing | undefined = editable
    ? {
        renaming: renamingSheetId,
        startRename: setRenamingSheetId,
        commitRename: commitSheetRename,
        cancelRename: () => {
          setRenamingSheetId(null);
        },
        remove: removeSheet,
      }
    : undefined;
  // KEYS-03: an undo or redo that brings a sheet back shows it — the person is looking for
  // it; one that takes the active sheet away falls to the neighbour rule below.
  const undoWithSheets = useCallback(
    (direction: 'undo' | 'redo') => {
      const before = new Set(listSheets(gd).map((s) => s.id));
      if (direction === 'undo') session.undo.undo();
      else session.undo.redo();
      const restored = listSheets(gd).find((s) => !before.has(s.id));
      if (restored !== undefined) {
        showSheet(restored.id);
        announce(restoredSheetAnnouncement(restored));
      }
    },
    [gd, session, showSheet],
  );
  // The sheet this replica showed has gone — a collaborator deleted it, or an undo or redo
  // did: the neighbour is shown and said, once, and the keyboard is put on its tab rather
  // than left on `body` (#165 §3).
  useEffect(() => {
    const previous = lastSheets.current;
    lastSheets.current = sheets;
    if (chosenSheetId === null || chosenPresent) return;
    const gone = previous.find((s) => s.id === chosenSheetId);
    const next = neighbourSheet(previous, sheets, chosenSheetId);
    if (next === null) return;
    showSheet(next.id);
    if (gone !== undefined) announce(remoteSheetRemovedAnnouncement(gone, next));
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected) {
      document
        .querySelector<HTMLElement>('.gd-doc__sheets [role="tab"][aria-selected="true"]')
        ?.focus({ preventScroll: true });
    }
  }, [sheets, chosenSheetId, chosenPresent, showSheet]);
  useEffect(() => {
    if (renamingSheetId !== null && !sheets.some((s) => s.id === renamingSheetId)) {
      setRenamingSheetId(null);
    }
  }, [sheets, renamingSheetId]);

  // -- viewport (DOC-04, DOC-07) ----------------------------------------------
  const measured = size.width > 0 ? size : null;
  const zoomStep = useCallback(
    (factor: number) => {
      setViewport((v) => zoomBy(v, factor, centre(measured ?? { width: 0, height: 0 })));
    },
    [measured],
  );
  const zoomPreset = useCallback(
    (zoom: number) => {
      setViewport((v) => zoomTo(v, zoom, centre(measured ?? { width: 0, height: 0 })));
    },
    [measured],
  );
  const fit = useCallback(() => {
    if (activeSheetId === null) return;
    const bounds = sheetBounds(gd, activeSheetId);
    setViewport(
      fitViewport(
        bounds === null ? null : unitBoundsToPx(bounds),
        measured ?? { width: 0, height: 0 },
        FIT_PADDING,
      ),
    );
    announce(bounds === null ? 'Nothing to fit on this sheet' : 'Fitted to canvas');
  }, [gd, activeSheetId, measured]);
  const onSizeChange = useCallback((next: Size) => {
    setSize((s) => (s.width === next.width && s.height === next.height ? s : next));
  }, []);

  /** Pan just enough that a lattice point is on screen. */
  const reveal = useCallback((col: number, row: number) => {
    setViewport((v) => {
      const x = col * LATTICE.col * v.zoom;
      const y = row * LATTICE.row * v.zoom;
      return clampViewport({
        x: x < v.x ? x - FIT_PADDING : v.x,
        y: y < v.y ? y - FIT_PADDING : v.y,
        zoom: v.zoom,
      });
    });
  }, []);

  // -- context graphs (GRAPH-01..11) --------------------------------------------
  // ADR-047: the hook reads its options through a ref, so the focus hand-off it needs
  // after a delete can be defined below, beside the object chords it shares logic with.
  const afterDeleteRef = useRef<
    (landing: { tableId: Id | null; fallback: SheetObject | null }) => void
  >(() => undefined);
  const graphs = useGraphs({
    gd,
    activeSheetId,
    editable,
    grid: { actions: grid.actions, commands: grid.commands },
    selectSheet,
    reveal,
    settle: () => {
      session.undo.stopCapturing();
    },
    afterDelete: (landing) => {
      afterDeleteRef.current(landing);
    },
  });
  const { select: selectGraph } = graphs.actions;
  const selectedGraphId = graphs.state.selectedGraphId;
  // A grid selection made in a table (not by a graph's write-back) drops the graph selection,
  // and clearing the selection clears both.
  const tableActions = useMemo(
    () => ({
      ...grid.actions,
      selectCell: (c: CellSelection) => {
        selectGraph(null);
        grid.actions.selectCell(c);
      },
      selectTable: (tableId: Id) => {
        selectGraph(null);
        grid.actions.selectTable(tableId);
      },
    }),
    [grid.actions, selectGraph],
  );
  const clearAll = useCallback(() => {
    clearSelection();
    selectGraph(null);
  }, [clearSelection, selectGraph]);
  const selectTable = tableActions.selectTable;

  // -- structure --------------------------------------------------------------
  const addTable = useCallback(
    (at?: { x: number; y: number }) => {
      if (activeSheetId === null || !editable) return;
      const bounds = sheetBounds(gd, activeSheetId);
      const origin =
        at ??
        (bounds === null
          ? { col: 1, row: 1 }
          : { col: bounds.col, row: bounds.row + bounds.rows + 1 });
      const id = createTable(gd, { sheetId: activeSheetId, at: origin, columns: 3, rows: 5 });
      const record = tableById(gd, id);
      if (record !== null) reveal(record.gridCol, record.gridRow);
      selectTable(id);
      announce(`Added ${record?.title ?? 'a table'}`);
    },
    [gd, activeSheetId, editable, reveal, selectTable],
  );
  const addRowToSelected = useCallback(() => {
    if (selection === null) return;
    grid.commands.insertRowBelow(selection.tableId, selection.cell?.rowId);
  }, [grid, selection]);
  const addColumnToSelected = useCallback(() => {
    if (selection === null) return;
    grid.commands.insertColumnAfter(selection.tableId, selection.cell?.colId);
  }, [grid, selection]);

  // -- find (FIND-01..10) ------------------------------------------------------
  const findNavigation = useMemo<FindNavigation>(
    () => ({
      onReveal: (match) => {
        if (match.target.kind === 'document') return;
        const { sheetId } = match.target;
        const bounds = matchBounds(gd, match);
        const switching = sheetId !== activeSheetId;
        if (switching) {
          setChosenSheetId(sheetId);
          grid.actions.clear();
        }
        if (bounds === null) return;
        // A sheet switch starts from A1 (as selectSheet does), then pans to the match.
        setViewport((v) =>
          revealBounds(
            switching ? { x: 0, y: 0, zoom: v.zoom } : v,
            measured ?? { width: 0, height: 0 },
            bounds,
            FIT_PADDING,
          ),
        );
      },
      onOpenDocument: (docId) => {
        void navigate(`/d/${encodeURIComponent(docId)}`);
      },
      onSelect: (match) => {
        if (match.target.kind !== 'cell') return;
        const { tableId, rowId, colId } = match.target;
        if (tableMap(gd, tableId) === null) return;
        grid.actions.selectCell({ tableId, rowId, colId });
      },
    }),
    [gd, activeSheetId, measured, navigate, grid],
  );
  const find = useFind({ gd, docId: doc.id, editable, navigation: findNavigation });

  // -- clipboard (KEYS-03, MENU-04) --------------------------------------------
  const addressOf = useCallback(
    (c: { tableId: Id; rowId: Id; colId: Id }) => {
      const table = tableMap(gd, c.tableId);
      return (table === null ? null : cellAddress(table, c.rowId, c.colId)) ?? 'the cell';
    },
    [gd],
  );
  const clipboard = useCellClipboard({
    gd,
    cell,
    editing: editing !== null,
    editable,
    locale,
    commands: grid.commands,
    addressOf,
  });

  // -- marks on a selected cell (KEYS-05, INSP-06) -----------------------------
  const toggleMark = useCallback(
    (mark: ToggleMark) => {
      if (cell === null || editing !== null || !editable) return;
      const table = tableMap(gd, cell.tableId);
      if (table === null) return;
      const next = toggleMarkThroughout(cellRich(table, cell.rowId, cell.colId), mark);
      grid.commands.commitRichCell(cell, next);
    },
    [gd, cell, editing, editable, grid],
  );

  // -- keyboard (KEYS-01..07): one map, listed by the shortcut sheet --------------
  const showInspector = useCallback((mode: InspectorMode, tab?: OrganizeTab) => {
    setInspectorMode(mode);
    if (tab !== undefined) setOrganizeTab(tab);
    setInspectorOpen(true);
  }, []);
  // ONB-04 / GRAPH-05: while the tour's step 3 asks for the dimensions, the Graph tab must
  // be on screen — the rail opens in Format mode (an overlay below 1024 px, RESP-03) each
  // time the person's graph is selected. The Graph tab itself scrolls its checklist into
  // the rail and hands it focus (A11Y-01).
  const tourGraphSubstep = useTourGraphSubstep();
  useEffect(() => {
    if (tourGraphSubstep === 'dimensions' && selectedGraphId !== null) showInspector('format');
  }, [tourGraphSubstep, selectedGraphId, showInspector]);
  // ADR-042 ⇧⌘→ / ⇧⌘←: the next or previous object on the sheet takes focus at its own
  // entry — a cell (which arms it), a graph's header. Tab cannot do this forward (GRID-05).
  // The objects are the document's, not the DOM's: a table outside the viewport is culled
  // (`visibleTables`), so the object is revealed first and focused once it has rendered.
  /**
   * Reveal an object and put focus at its entry. Returns false when it could not be
   * found in the DOM. Used by ⇧⌘→ / ⇧⌘← and, after a delete (ADR-047), to land on
   * the surviving object.
   */
  const focusObject = useCallback(
    (next: SheetObject, options: { announceName: boolean }) => {
      const bounds = objectBounds(gd, next);
      const entryCell = next.kind === 'table' ? tableEntry(gd, next.id, cell) : null;
      // Synchronous, so the revealed table is in the DOM before its entry is looked up.
      flushSync(() => {
        if (bounds !== null) {
          // The same fallback size the culling uses before the canvas is measured.
          setViewport((v) =>
            revealBounds(
              v,
              measured ?? { width: theme.breakpoint.lg, height: theme.breakpoint.md },
              bounds,
              FIT_PADDING,
            ),
          );
        }
        if (entryCell !== null) grid.actions.selectCell(entryCell);
      });
      const section = objectElement(next);
      const entry = section === null ? null : objectEntry(section);
      if (section === null || entry === null) return false;
      entry.focus({ preventScroll: true });
      if (options.announceName) announce(section.getAttribute('aria-label') ?? 'Object');
      return true;
    },
    [gd, cell, measured, grid.actions],
  );
  const moveObject = useCallback(
    (direction: 1 | -1) => {
      if (activeSheetId === null) return;
      const objects = sheetObjects(gd, activeSheetId);
      const next = stepObject(objects, currentObject(document.activeElement), direction);
      if (next === null) {
        announce('Nothing on this sheet');
        return;
      }
      if (!focusObject(next, { announceName: true })) announce('No other object on this sheet');
    },
    [gd, activeSheetId, focusObject],
  );
  // ADR-047 (#163): after a delete, focus lands on an object that is left — the bound table
  // when a graph half went, else the object before it; the next object when a table went —
  // and on the canvas plane when nothing is, so the keyboard is never dropped on `body`.
  // The announcement is the delete's own and comes after the landing.
  const landAfterDelete = useCallback(
    (landing: { tableId: Id | null; fallback: SheetObject | null }) => {
      const candidates: SheetObject[] = [];
      if (landing.tableId !== null) candidates.push({ kind: 'table', id: landing.tableId });
      if (landing.fallback !== null) candidates.push(landing.fallback);
      for (const candidate of candidates) {
        if (focusObject(candidate, { announceName: false })) return;
      }
      document.querySelector<HTMLElement>('.gd-canvas__plane')?.focus({ preventScroll: true });
    },
    [focusObject],
  );
  afterDeleteRef.current = landAfterDelete;
  const deleteTable = useCallback(
    (tableId: Id) => {
      if (editing !== null || activeSheetId === null) return;
      // FX-06: dependents elsewhere fall to the reference-removed error; the engine reports
      // them in the batch that answers this change, and the announcement names the count.
      const engine = peekEngine(gd.doc);
      let broken = 0;
      const stop = engine?.subscribeAll((touched) => {
        for (const id of touched) {
          if (engine.result(id)?.error?.kind === 'reference-removed') broken += 1;
        }
      });
      const objects = sheetObjects(gd, activeSheetId);
      const index = objects.findIndex((o) => o.kind === 'table' && o.id === tableId);
      // One undo step of its own: never merged into a change made just before it (KEYS-03).
      session.undo.stopCapturing();
      const outcome = grid.commands.deleteTable(tableId);
      if (outcome === null) {
        stop?.();
        return;
      }
      const left = sheetObjects(gd, activeSheetId);
      const next = left[Math.min(Math.max(index, 0), left.length - 1)] ?? null;
      landAfterDelete({ tableId: null, fallback: next });
      const finish = () => {
        stop?.();
        announce(deletedTableAnnouncement(outcome, broken));
      };
      if (engine === undefined) finish();
      else void engine.settled().then(finish);
    },
    [gd, editing, activeSheetId, grid.commands, landAfterDelete, session.undo],
  );
  const deleteSelectedTable = useCallback(() => {
    if (selection !== null) deleteTable(selection.tableId);
  }, [selection, deleteTable]);
  const selectedGraph = selectedGraphId === null ? null : graphById(gd, selectedGraphId);
  useShortcuts(
    documentBindings({
      phone,
      editable,
      cell,
      editing: editing !== null,
      hasSelection: selection !== null,
      find: {
        open: find.state.open,
        show: find.actions.open,
        close: find.actions.close,
        next: find.actions.next,
        previous: find.actions.previous,
      },
      document: {
        open: () => {
          void navigate('/');
        },
        print: () => {
          window.print();
        },
      },
      layerOpen: shortcutsOpen || menuOpen,
      view: {
        zoomIn: () => {
          zoomStep(ZOOM_STEP);
        },
        zoomOut: () => {
          zoomStep(1 / ZOOM_STEP);
        },
        actualSize: () => {
          zoomPreset(1);
        },
        fit,
        toggleInspector: () => {
          setInspectorOpen((o) => !o);
        },
        showInspector,
        toggleShortcutSheet: () => {
          setShortcutsOpen((o) => !o);
        },
        nextObject: () => {
          moveObject(1);
        },
        previousObject: () => {
          moveObject(-1);
        },
      },
      edit: {
        undo: () => {
          undoWithSheets('undo');
        },
        redo: () => {
          undoWithSheets('redo');
        },
        // KEYS-03 ⌘A selects the table (the object); there is no range selection (ADR-042).
        selectAll: () => {
          if (selection !== null) selectTable(selection.tableId);
        },
        clear: () => {
          if (cell !== null) grid.commands.clearCell(cell);
        },
        deleteTable: deleteSelectedTable,
        clearSelection: clearAll,
        toggleMark,
      },
      table: { addRow: addRowToSelected, addColumn: addColumnToSelected },
      // ADR-047: ⌫ / Delete on a selected half removes that half; ⌥← / ⌥→ collapse or expand it.
      graph: {
        selected: selectedGraph !== null,
        pointing: graphs.state.pointing !== null,
        remove: () => {
          if (selectedGraph !== null)
            graphs.actions.removeHalf(selectedGraph.pairId, selectedGraph.kind);
        },
        collapse: () => {
          if (selectedGraph !== null) graphs.actions.setCollapsed(selectedGraph.id, true);
        },
        expand: () => {
          if (selectedGraph !== null) graphs.actions.setCollapsed(selectedGraph.id, false);
        },
      },
      clipboard,
      hierarchy: {
        nest: (c) => grid.commands.nestRow(c.tableId, c.rowId),
        promote: (c) => grid.commands.promoteRow(c.tableId, c.rowId),
        collapse: (c) => grid.commands.setCollapsed(c.tableId, c.rowId, true),
        expand: (c) => grid.commands.setCollapsed(c.tableId, c.rowId, false),
      },
    }),
  );

  // -- context menus (MENU-01..05) ----------------------------------------------
  const menuContext: MenuContext = {
    gd,
    editable,
    commands: grid.commands,
    clipboard,
    selectedCell: cell,
    canvas: {
      addTable: () => {
        addTable();
      },
      addGraph: graphs.actions.startPointing,
      addShapedTable: () => {
        graphs.actions.addShapedTable();
      },
      fit,
      actualSize: () => {
        zoomPreset(1);
      },
    },
    sheets: { add: appendSheet, rename: setRenamingSheetId, remove: removeSheet },
    selectTable,
    // ADR-047: the pointer routes to the object deletes and collapse.
    deleteTable: editable ? deleteTable : undefined,
    graphs: editable
      ? {
          select: graphs.actions.select,
          remove: graphs.actions.remove,
          removeHalf: graphs.actions.removeHalf,
          setCollapsed: graphs.actions.setCollapsed,
        }
      : undefined,
    slots: {
      // SORT-01..06 (#74): the viewer's own sort, filter and grouping; the options live in
      // the Organize inspector, so "show … options" opens it.
      sort: {
        sortAscending: (tableId, colId) => {
          sort.setSort(tableId, colId, 'az');
        },
        sortDescending: (tableId, colId) => {
          sort.setSort(tableId, colId, 'za');
        },
        showSortOptions: () => {
          showInspector('organize', 'sort');
        },
        quickFilter: () => {
          showInspector('organize', 'filter');
        },
        showFilterOptions: () => {
          showInspector('organize', 'filter');
        },
      },
      hierarchy: {
        isCategory: (tableId, colId) => sort.view(tableId)?.groupBy === colId,
        addCategory: (tableId, colId) => {
          sort.setGroupBy(tableId, colId);
        },
        removeCategory: (tableId) => {
          sort.setGroupBy(tableId, null);
        },
        showCategoryOptions: () => {
          showInspector('organize', 'categories');
        },
      },
      // GRAPH-01: "Graph this table" creates a pair bound to that table.
      graph: editable ? { graphTable: graphs.actions.graphTable } : undefined,
    },
  };

  // -- render -----------------------------------------------------------------
  const range = visibleRange(
    viewport,
    measured ?? { width: theme.breakpoint.lg, height: theme.breakpoint.md },
  );
  // INSP-07 / PRD §10: pinned tables render in the viewport layer whatever the pan.
  const pinnedTables = tables.filter((t) => t.pinned);
  const visibleTables = tables.filter((t) => {
    const map = tableMap(gd, t.id);
    if (map === null) return false;
    const b = tableUnitBounds(map, t);
    return (
      b.col <= range.colEnd + 1 &&
      b.col + b.cols + 1 >= range.colStart &&
      b.row <= range.rowEnd + 1 &&
      b.row + b.rows + 1 >= range.rowStart
    );
  });
  const failure = sync.failure;
  const sharedFlag = doc.sharedBy !== undefined || doc.sharedWithOthers === true;

  return (
    <div
      className={clsx('gd-doc', {
        'gd-doc--phone': phone,
        'gd-doc--inspector': inspectorOpen && !phone,
        'gd-doc--inspector-strip': !inspectorOpen && !phone,
      })}
      data-replica={replica}
      data-sync={sync.status}
    >
      <TitleBar
        docId={doc.id}
        gd={gd}
        serverTitle={doc.title}
        sharedFlag={sharedFlag}
        participants={others}
        shareSlot={<ShareControls doc={doc} participants={others} phone={phone} />}
        sync={sync}
        ready={ready}
        phone={phone}
        editable={editable}
        focusTitle={focusTitle}
        onRenameError={setRenameError}
        renameLocked={doc.sample === true ? SAMPLE_RENAME_REASON : undefined}
      />

      {!phone && (
        <Toolbar
          zoom={viewport.zoom}
          gridlines={gridlines}
          hasTable={selection !== null}
          editable={editable}
          inspector={inspectorOpen ? inspectorMode : null}
          onAddTable={() => {
            addTable();
          }}
          onAddGraph={graphs.actions.startPointing}
          onAddRow={addRowToSelected}
          onAddColumn={addColumnToSelected}
          tableMenu={
            <TableMenu
              gd={gd}
              selection={selection}
              editable={editable}
              commands={grid.commands}
              onDeleteTable={deleteTable}
            />
          }
          onGridlines={setGridlines}
          pinned={selectedTable?.pinned ?? null}
          onPin={(on) => {
            if (selectedTable !== null) grid.commands.setTablePinned(selectedTable.id, on);
          }}
          edgesShown={activeSheetId !== null && sheetEdgesShown(gd, activeSheetId)}
          onEdges={(on) => {
            if (activeSheetId !== null) grid.commands.setSheetEdgesShown(activeSheetId, on);
          }}
          onZoomIn={() => {
            zoomStep(ZOOM_STEP);
          }}
          onZoomOut={() => {
            zoomStep(1 / ZOOM_STEP);
          }}
          onZoomTo={zoomPreset}
          onFit={fit}
          onInspector={(mode) => {
            if (mode === null) setInspectorOpen(false);
            else showInspector(mode);
          }}
          onFind={() => {
            find.actions.open();
          }}
          onShortcuts={() => {
            setShortcutsOpen(true);
          }}
          onOrganize={(tab) => {
            showInspector('organize', tab);
          }}
          documentMenu={
            <DocumentMenu
              editable={editable}
              undo={session.undo}
              onOpen={() => {
                void navigate('/');
              }}
              onPrint={() => {
                window.print();
              }}
            />
          }
        />
      )}

      <div className="gd-doc__banners">
        {/* wave2/formulas mount point */}
        <FormulaEngineBanner doc={gd.doc} />
        {graphs.state.pointing !== null && (
          // ONB-04 / ONB-11: the tour's `point` card spotlights the banner with the targets
          // (`data-tour`) and keeps it above the scrim.
          <div
            className={clsx('gd-doc__pointing', {
              'gd-doc__pointing--lit': tourGraphSubstep === 'point',
            })}
            data-tour="pointing"
            data-testid="pointing-banner"
          >
            <Banner
              cause={
                graphs.state.pointing.mode === 'rebind'
                  ? 'Click a table to re-point the graph.'
                  : 'Click a table to bind the graph.'
              }
              remedy="Press Escape to cancel, or add a shaped table and bind it in one step."
              action={
                <>
                  <Button
                    size="sm"
                    onClick={() => {
                      graphs.actions.addShapedTable();
                    }}
                  >
                    Add shaped table
                  </Button>
                  <Button size="sm" onClick={graphs.actions.cancelPointing}>
                    Cancel
                  </Button>
                </>
              }
            />
          </div>
        )}
        {renameError !== null && (
          <Banner
            cause="Rename not saved."
            remedy={renameError}
            action={
              <Button
                size="sm"
                onClick={() => {
                  setRenameError(null);
                }}
              >
                Dismiss
              </Button>
            }
          />
        )}
        {failure !== null && failure.code === CLOSE_UNAUTHENTICATED && (
          <Banner
            cause="Your session ended."
            remedy="Sign in again to keep syncing; edits are held on this device and sync once you are back."
            action={
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  // AUTH-01 / AUTH-09: the document path survives the round trip; the dead
                  // tokens are dropped first so the sign-in screen does not bounce back.
                  rememberReturnTo(`${location.pathname}${location.search}${location.hash}`);
                  void signOutLocal()
                    .catch(() => undefined)
                    .then(() => navigate('/sign-in'));
                }}
              >
                Sign in
              </Button>
            }
          />
        )}
        {failure !== null && failure.code !== CLOSE_UNAUTHENTICATED && (
          <Banner
            cause="Changes are not syncing."
            remedy={failureRemedy(failure.code)}
            action={
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  session.sync.retry();
                }}
              >
                Retry
              </Button>
            }
          />
        )}
        {sync.readOnly && permissionOf(doc) !== 'view' && (
          <Banner
            cause="Your access is now view-only."
            remedy="The owner changed your permission. Edits made since are held on this device and will not sync."
          />
        )}
        {failure === null && sync.status === 'offline' && (
          <Banner
            cause="Work is saved on this device."
            remedy="You are offline. Edits keep going here and merge when the connection returns."
            action={
              <Button
                size="sm"
                onClick={() => {
                  session.sync.retry();
                }}
              >
                Retry now
              </Button>
            }
          />
        )}
      </div>

      {/* MENU-01..05: one context menu over the canvas, the tables and the sheet strip. */}
      <DocumentContextMenu
        gd={gd}
        phone={phone}
        context={menuContext}
        actions={grid.actions}
        onOpenChange={setMenuOpen}
      >
        <div className="gd-doc__main">
          <Skeleton
            active={!ready}
            tiers={tiers}
            rows={8}
            statusLabel={`Loading ${doc.title}`}
            className="gd-doc__skeleton"
          >
            <Canvas
              viewport={viewport}
              onViewportChange={setViewport}
              onSizeChange={onSizeChange}
              gridlines={gridlines}
              onClearSelection={clearAll}
              onPlaceTable={
                editable
                  ? (at) => {
                      addTable(at);
                    }
                  : undefined
              }
              pinned={
                pinnedTables.length === 0
                  ? undefined
                  : pinnedTables.map((t) => {
                      const map = tableMap(gd, t.id);
                      if (map === null) return null;
                      // Anchored at the plane's edge: the wrapper cancels the lattice origin.
                      return (
                        <div
                          key={t.id}
                          className="gd-pinned"
                          style={{
                            transform: `translate(${String(-t.gridCol * LATTICE.col)}px, ${String(-t.gridRow * LATTICE.row)}px)`,
                          }}
                        >
                          <TableView
                            table={map}
                            tier={tier}
                            selected={selection?.tableId === t.id}
                            selectedCell={cell !== null && cell.tableId === t.id ? cell : null}
                            axisBand={selection?.tableId === t.id ? (selection.band ?? null) : null}
                            fitter={fitter}
                            editing={
                              editing !== null && editing.cell.tableId === t.id ? editing : null
                            }
                            editable={editable}
                            presence={onSheet}
                            pinnedLeft={null}
                            undo={session.undo}
                            actions={grid.actions}
                            commands={grid.commands}
                            sort={phone ? undefined : sort}
                          />
                        </div>
                      );
                    })
              }
            >
              {visibleTables.map((t) => {
                const map = tableMap(gd, t.id);
                if (map === null) return null;
                // INSP-07 / PRD §10: a pinned table's live copy is in the pinned layer; here a
                // ghost keeps its place in the DAG — inert, so no duplicate tab stops or grid.
                if (t.pinned) {
                  return (
                    <div key={t.id} className="gd-ghost" inert data-testid="pinned-ghost">
                      <span className="gd-ghost__label">Pinned to viewport</span>
                      <TableView
                        table={map}
                        tier={tier}
                        selected={false}
                        selectedCell={null}
                        editing={null}
                        editable={false}
                        presence={NO_PRESENCE}
                        pinnedLeft={null}
                        actions={grid.actions}
                        commands={grid.commands}
                      />
                    </div>
                  );
                }
                return (
                  <TableView
                    key={t.id}
                    table={map}
                    tier={tier}
                    selected={selection?.tableId === t.id}
                    selectedCell={cell !== null && cell.tableId === t.id ? cell : null}
                    axisBand={selection?.tableId === t.id ? (selection.band ?? null) : null}
                    fitter={fitter}
                    editing={editing !== null && editing.cell.tableId === t.id ? editing : null}
                    editable={editable}
                    presence={onSheet}
                    pinnedLeft={pinnedPanelOffset(t, viewport.x / viewport.zoom)}
                    undo={session.undo}
                    actions={tableActions}
                    commands={grid.commands}
                    sort={phone ? undefined : sort}
                  />
                );
              })}
              {/* wave4/inspector-controls: DAG edges between the sheet's tables (INSP-07, PRD §7) */}
              <DagEdges gd={gd} sheetId={activeSheetId} />
              {/* FIND-06: amber match highlights, in the layer so they pan and zoom with the tables. */}
              <MatchHighlights
                gd={gd}
                matches={find.state.matches}
                current={find.state.current}
                sheetId={activeSheetId}
                viewportLeftPx={viewport.x / viewport.zoom}
              />
              {/* wave2/formulas mount point: FX-08 outlines for the selected or edited formula */}
              <FormulaLayer
                gd={gd}
                sheetId={activeSheetId}
                zoom={viewport.zoom}
                selected={cell}
                editing={editing?.cell ?? null}
              />
              {/* wave4/graphs: ring and coverage pairs, pointing overlay (GRAPH-01..11) */}
              <GraphLayer
                gd={gd}
                sheetId={activeSheetId}
                graphs={graphs}
                selectedCell={cell}
                editable={editable}
                zoom={viewport.zoom}
              />
              {ready &&
                tables.length === 0 &&
                graphsOnSheet(gd, activeSheetId ?? '').length === 0 && (
                  <div className="gd-canvas__empty" style={emptyStyle()}>
                    <span className="gd-mono gd-canvas__empty-label">empty sheet</span>
                    {editable ? (
                      <div className="gd-canvas__empty-actions">
                        <Button
                          size="sm"
                          variant="primary"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                          }}
                          onClick={() => {
                            addTable();
                          }}
                        >
                          Place first table
                        </Button>
                        {/* PRD §19: the empty-sheet menu is Table / Shaped table / Graph. */}
                        <Button
                          size="sm"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                          }}
                          onClick={() => {
                            graphs.actions.addShapedTable();
                          }}
                        >
                          Add shaped table here
                        </Button>
                        <Button
                          size="sm"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                          }}
                          onClick={graphs.actions.startPointing}
                        >
                          Add graph here
                        </Button>
                      </div>
                    ) : (
                      <span className="gd-canvas__empty-text">Nothing on this sheet yet</span>
                    )}
                  </div>
                )}
            </Canvas>
          </Skeleton>
          {/* FIND-02: the Find bar floats at the foot of the canvas and never displaces content. */}
          <FindBar
            gd={gd}
            find={find}
            editable={editable}
            phone={phone}
            resultsInInspector={inspectorOpen && !phone}
          />
          {!phone && (
            <Inspector
              gd={gd}
              mode={inspectorMode}
              open={inspectorOpen}
              onOpenChange={setInspectorOpen}
              organizeTab={organizeTab}
              onOrganizeTabChange={setOrganizeTab}
              object={selectedGraphId === null ? undefined : describeGraph(gd, selectedGraphId)}
              selection={selection}
              editing={editing !== null}
              editable={editable}
              commands={grid.commands}
              find={find}
              onToggleMark={toggleMark}
              slots={{
                // SORT-01..06 (#74) / INSP-01: one panel carries Categories, Sort and Filter;
                // each Organize tab shows its own section of it (#138).
                hierarchy: (
                  <SortPanel
                    gd={gd}
                    tableId={selection?.tableId ?? null}
                    commands={sort}
                    section="categories"
                  />
                ),
                sort: (
                  <SortPanel
                    gd={gd}
                    tableId={selection?.tableId ?? null}
                    commands={sort}
                    section="sort"
                  />
                ),
                filter: (
                  <SortPanel
                    gd={gd}
                    tableId={selection?.tableId ?? null}
                    commands={sort}
                    section="filter"
                  />
                ),
                // REF-02..04 (#77): cross-table relation, derived-column composition and the
                // pipeline audit list, for the selected table.
                derive:
                  selection?.tableId === undefined ? undefined : (
                    <DerivePanel
                      gd={gd}
                      tableId={selection.tableId}
                      sourceColId={cell?.colId}
                      undo={session.undo}
                      editable={editable}
                    />
                  ),
                // INSP-08 / GRAPH-05: the Graph tab, only while a graph is selected.
                graph:
                  selectedGraphId === null ? undefined : (
                    <GraphTab
                      gd={gd}
                      graphId={selectedGraphId}
                      graphs={graphs}
                      selectedCell={cell}
                      editable={editable}
                    />
                  ),
              }}
            />
          )}
        </div>

        <SheetTabs
          gd={gd}
          activeSheetId={activeSheetId}
          onSelect={selectSheet}
          onAppend={editable ? appendSheet : undefined}
          edit={sheetEditing}
          bottom={phone}
        />
      </DocumentContextMenu>
      {/* LIB-D9 / ADR-031: a deleted sheet goes straight through; the toast's Undo is the safety. */}
      <Toast
        open={sheetNotice !== null}
        onOpenChange={(open) => {
          if (!open) setSheetNotice(null);
        }}
        title={sheetNotice?.title ?? ''}
        undo={
          sheetNotice === null
            ? undefined
            : { onUndo: sheetNotice.undo, altText: 'Undo deleting the sheet' }
        }
      />
      <ShortcutSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      {selectedTable !== null && (
        <span className="gd-visually-hidden" data-testid="selected-table">
          {selectedTable.title}
        </span>
      )}
    </div>
  );
}

/**
 * ADR-047 (#163): "Deleted Table 1 and its graph — 3 cells elsewhere now read
 * “reference removed”; press ⌘Z to undo", in the active locale.
 */
function deletedTableAnnouncement(outcome: { title: string; graphs: number }, broken: number) {
  const locale = activeLocale();
  const name =
    outcome.graphs === 0
      ? outcome.title
      : outcome.graphs === 1
        ? translate(locale, 'object.name.tableGraph', { table: outcome.title })
        : translate(locale, 'object.name.tableGraphs', {
            table: outcome.title,
            count: formatNumber(locale, outcome.graphs),
          });
  const undo = LABELS.undo;
  if (broken === 0) return translate(locale, 'object.deleted', { name, undo });
  if (broken === 1) return translate(locale, 'object.deleted.ref', { name, undo });
  return translate(locale, 'object.deleted.refs', {
    name,
    undo,
    count: formatNumber(locale, broken),
  });
}

/** INSP-03 / INSP-08: what the head says of a selected graph — its kind, source and dimensions. */
function describeGraph(gd: GedeDoc, graphId: Id): HeadObject | undefined {
  const graph = graphById(gd, graphId);
  if (graph === null) return undefined;
  const source = graph.tableId === null ? null : tableById(gd, graph.tableId);
  const kind = graph.kind === 'ring' ? 'Ring graph' : 'Coverage graph';
  const n = graph.dimensions.length;
  return {
    label: source === null ? kind : `${kind} of ${source.title}`,
    facts: [
      source === null ? 'not pointed at a table' : `${String(source.rows.length)} source rows`,
      `${String(n)} ${n === 1 ? 'dimension' : 'dimensions'}`,
    ],
  };
}

/** The empty-sheet affordance sits one unit in from A1, on the lattice. */
function emptyStyle() {
  return { left: `${String(LATTICE.col)}px`, top: `${String(LATTICE.row * 2)}px` };
}

function failureRemedy(code: number): string {
  switch (code) {
    case CLOSE_FORBIDDEN:
      return 'You no longer have access to this workscape. Edits are held on this device.';
    case CLOSE_NOT_FOUND:
      return 'This workscape was deleted. Anything deleted in the last 30 days can be recovered from Recently Deleted.';
    // #99: the server refused the edit on its size, not the connection. The
    // oversized change sits in this device's replica and is offered again on
    // every reconnect, so Retry cannot succeed; sign-out is what discards the
    // replica (AUTH-09), and that is the remedy named.
    case CLOSE_MESSAGE_TOO_BIG:
      return 'Your last change is too large to sync and is held on this device only. Copy what you need from it, then sign out and sign in again to discard it and reopen the workscape.';
    case CLOSE_TOO_LARGE:
      return 'This workscape has reached its size limit, so your last change is held on this device only. Copy what you need from it, then sign out and sign in again to discard it. Remove content before editing further.';
    default:
      return 'The sync service refused the connection. Edits are held on this device.';
  }
}
