import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  createSheet,
  createTable,
  LATTICE,
  listSheets,
  sheetBounds,
  tableById,
  tableMap,
  tablesOnSheet,
  tableUnitBounds,
  toPresenceState,
  unitBoundsToPx,
  type Id,
  type PresenceState,
} from '@gede/core';
import { below, theme } from '@gede/tokens';
import { Banner, Button, Skeleton, useLoadingTiers, type LoadingTiers } from '@gede/ui';

import { announce } from '../../announce.js';
import { getDocument, permissionOf, type DocumentSummary } from '../../api/documents.js';
import { signOutLocal } from '../../auth/cognito.js';
import { rememberReturnTo, useSession } from '../../auth/session.js';
import { ApiError } from '../../api/client.js';
import { usePresenceColour } from '../../doc/presence.js';
import { rememberLastDocument } from '../../last-document.js';
import { CHORDS, LABELS, useShortcuts, type ShortcutBinding } from '../../doc/shortcuts.js';
import {
  CLOSE_FORBIDDEN,
  CLOSE_NOT_FOUND,
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
import { useMediaQuery } from '../../use-media-query.js';
import { Canvas } from './Canvas.js';
import { FindBar } from './find/FindBar.js';
import { MatchHighlights } from './find/MatchHighlights.js';
import { matchBounds } from './find/match-geometry.js';
import { useFind, type FindNavigation } from './find/useFind.js';
import { FormulaEngineBanner, FormulaLayer } from './formula/index.js'; // wave2/formulas mount points
import { pinnedPanelOffset } from './grid/pinned.js';
import { TableMenu } from './grid/TableMenu.js';
import { useGrid } from './grid/use-grid.js';
import { Inspector } from './Inspector.js';
import { SheetTabs } from './SheetTabs.js';
import { TableView } from './TableView.js';
import { TitleBar } from './TitleBar.js';
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
export function DocumentShell() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const phone = useMediaQuery(below('md'));
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
  const wide = useMediaQuery('(min-width: 1200px)');
  // The shell watches structure only (sheets and objects added or removed); each
  // TableView watches its own map deeply, so a cell edit re-renders one table.
  useYVersion(gd.sheets); // deep: a sheet label lives in a nested map
  useYVersion(gd.tables, { depth: 'shallow' });
  useYVersion(gd.graphs, { depth: 'shallow' });
  const awarenessVersion = useAwarenessVersion(session.sync.awareness);

  // Viewer state (never document state): active sheet, selection, viewport, chrome toggles.
  const sheets = listSheets(gd);
  const [chosenSheetId, setChosenSheetId] = useState<Id | null>(null);
  const activeSheetId =
    chosenSheetId !== null && sheets.some((s) => s.id === chosenSheetId)
      ? chosenSheetId
      : (sheets[0]?.id ?? null);
  // Selection, editing and traversal (GRID-03..06) live in the grid state machine.
  const grid = useGrid(gd, editable, { undo: session.undo });
  const { selection, editing } = grid.state;
  const [viewport, setViewport] = useState<Viewport>(INITIAL_VIEWPORT);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [gridlines, setGridlines] = useState(true);
  const [inspector, setInspector] = useState<InspectorMode | null>(() => (wide ? 'format' : null));
  const [renameError, setRenameError] = useState<string | null>(null);

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
  const { selectTable, clear: clearSelection } = grid.actions;

  // -- sheets (DOC-03) --------------------------------------------------------
  const selectSheet = useCallback(
    (sheetId: Id) => {
      setChosenSheetId(sheetId);
      clearSelection();
      setViewport((v) => ({ x: 0, y: 0, zoom: v.zoom }));
      const sheet = listSheets(gd).find((s) => s.id === sheetId);
      if (sheet !== undefined) announce(`Sheet ${String(sheet.ordinal)}, ${sheet.label}`);
    },
    [gd, clearSelection],
  );
  const appendSheet = useCallback(() => {
    const id = createSheet(gd);
    selectSheet(id);
  }, [gd, selectSheet]);
  const stepSheet = useCallback(
    (delta: number) => {
      const list = listSheets(gd);
      if (list.length === 0) return;
      const index = Math.max(
        0,
        list.findIndex((s) => s.id === activeSheetId),
      );
      const next = list[(index + delta + list.length) % list.length];
      if (next !== undefined && next.id !== activeSheetId) selectSheet(next.id);
    },
    [gd, activeSheetId, selectSheet],
  );

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

  // -- keyboard (KEYS-07, KEYS-06, KEYS-04) -----------------------------------
  const bindings: ShortcutBinding[] = [
    // Find first: ⌘F and friends work from the Find field too (inEditors), and
    // Esc closes the bar before it would clear the selection.
    {
      id: 'find',
      chord: CHORDS.find,
      label: LABELS.find,
      run: () => {
        find.actions.open();
      },
      inEditors: true,
    },
    {
      id: 'findReplace',
      chord: CHORDS.findReplace,
      label: LABELS.findReplace,
      run: () => {
        find.actions.open({ replace: true });
      },
      inEditors: true,
      disabled: phone,
    },
    {
      id: 'findNext',
      chord: CHORDS.findNext,
      label: LABELS.findNext,
      run: find.actions.next,
      inEditors: true,
      disabled: !find.state.open,
    },
    {
      id: 'findPrevious',
      chord: CHORDS.findPrevious,
      label: LABELS.findPrevious,
      run: find.actions.previous,
      inEditors: true,
      disabled: !find.state.open,
    },
    {
      id: 'closeFind',
      chord: CHORDS.escape,
      label: LABELS.escape,
      run: find.actions.close,
      inEditors: true,
      disabled: !find.state.open,
    },
    {
      id: 'zoomIn',
      chord: CHORDS.zoomIn,
      label: LABELS.zoomIn,
      run: () => {
        zoomStep(ZOOM_STEP);
      },
    },
    // ⌘+ is ⌘⇧= on most layouts; accept both physical spellings.
    {
      id: 'zoomInShift',
      chord: { ...CHORDS.zoomIn, shift: true },
      label: LABELS.zoomIn,
      run: () => {
        zoomStep(ZOOM_STEP);
      },
    },
    {
      id: 'zoomOut',
      chord: CHORDS.zoomOut,
      label: LABELS.zoomOut,
      run: () => {
        zoomStep(1 / ZOOM_STEP);
      },
    },
    {
      id: 'actualSize',
      chord: CHORDS.actualSize,
      label: LABELS.actualSize,
      run: () => {
        zoomPreset(1);
      },
    },
    { id: 'fit', chord: CHORDS.fit, label: LABELS.fit, run: fit },
    {
      id: 'nextSheet',
      chord: CHORDS.nextSheet,
      label: LABELS.nextSheet,
      run: () => {
        stepSheet(1);
      },
      inEditors: true,
    },
    {
      id: 'previousSheet',
      chord: CHORDS.previousSheet,
      label: LABELS.previousSheet,
      run: () => {
        stepSheet(-1);
      },
      inEditors: true,
    },
    {
      id: 'inspector',
      chord: CHORDS.inspector,
      label: LABELS.inspector,
      run: () => {
        setInspector((m) => (m === null ? 'format' : null));
      },
      disabled: phone,
    },
    {
      id: 'formatInspector',
      chord: CHORDS.formatInspector,
      label: LABELS.formatInspector,
      run: () => {
        setInspector('format');
      },
      disabled: phone,
    },
    {
      id: 'organizeInspector',
      chord: CHORDS.organizeInspector,
      label: LABELS.organizeInspector,
      run: () => {
        setInspector('organize');
      },
      disabled: phone,
    },
    {
      id: 'addRow',
      chord: CHORDS.addRow,
      label: LABELS.addRow,
      run: addRowToSelected,
      disabled: !editable,
    },
    {
      id: 'addColumn',
      chord: CHORDS.addColumn,
      label: LABELS.addColumn,
      run: addColumnToSelected,
      disabled: !editable,
    },
    {
      id: 'undo',
      chord: CHORDS.undo,
      label: LABELS.undo,
      run: () => session.undo.undo(),
      disabled: !editable,
    },
    {
      id: 'redo',
      chord: CHORDS.redo,
      label: LABELS.redo,
      run: () => session.undo.redo(),
      disabled: !editable,
    },
    { id: 'escape', chord: CHORDS.escape, label: LABELS.escape, run: clearSelection },
  ];
  useShortcuts(bindings);

  // -- render -----------------------------------------------------------------
  const range = visibleRange(
    viewport,
    measured ?? { width: theme.breakpoint.lg, height: theme.breakpoint.md },
  );
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
        'gd-doc--inspector': inspector !== null && !phone,
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
      />

      {!phone && (
        <Toolbar
          zoom={viewport.zoom}
          gridlines={gridlines}
          hasTable={selection !== null}
          editable={editable}
          inspector={inspector}
          onAddTable={() => {
            addTable();
          }}
          onAddRow={addRowToSelected}
          onAddColumn={addColumnToSelected}
          tableMenu={
            <TableMenu gd={gd} selection={selection} editable={editable} commands={grid.commands} />
          }
          onGridlines={setGridlines}
          onZoomIn={() => {
            zoomStep(ZOOM_STEP);
          }}
          onZoomOut={() => {
            zoomStep(1 / ZOOM_STEP);
          }}
          onZoomTo={zoomPreset}
          onFit={fit}
          onInspector={setInspector}
          onFind={() => {
            find.actions.open();
          }}
        />
      )}

      <div className="gd-doc__banners">
        {/* wave2/formulas mount point */}
        <FormulaEngineBanner doc={gd.doc} />
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
            onClearSelection={clearSelection}
            onPlaceTable={
              editable
                ? (at) => {
                    addTable(at);
                  }
                : undefined
            }
          >
            {visibleTables.map((t) => {
              const map = tableMap(gd, t.id);
              if (map === null) return null;
              return (
                <TableView
                  key={t.id}
                  table={map}
                  tier={tier}
                  selected={selection?.tableId === t.id}
                  selectedCell={cell !== null && cell.tableId === t.id ? cell : null}
                  editing={editing !== null && editing.cell.tableId === t.id ? editing : null}
                  editable={editable}
                  presence={onSheet}
                  pinnedLeft={pinnedPanelOffset(t, viewport.x / viewport.zoom)}
                  undo={session.undo}
                  actions={grid.actions}
                  commands={grid.commands}
                />
              );
            })}
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
            {ready && tables.length === 0 && (
              <div className="gd-canvas__empty" style={emptyStyle()}>
                <span className="gd-mono gd-canvas__empty-label">empty sheet</span>
                {editable ? (
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
                ) : (
                  <span className="gd-canvas__empty-text">Nothing on this sheet yet</span>
                )}
              </div>
            )}
          </Canvas>
        </Skeleton>
        {/* FIND-02: the Find bar floats at the foot of the canvas and never displaces content. */}
        <FindBar gd={gd} find={find} editable={editable} phone={phone} />
        {inspector !== null && !phone && (
          <Inspector
            gd={gd}
            mode={inspector}
            selection={selection}
            onClose={() => {
              setInspector(null);
            }}
          />
        )}
      </div>

      <SheetTabs
        gd={gd}
        activeSheetId={activeSheetId}
        onSelect={selectSheet}
        onAppend={editable ? appendSheet : undefined}
        bottom={phone}
      />
      {selectedTable !== null && (
        <span className="gd-visually-hidden" data-testid="selected-table">
          {selectedTable.title}
        </span>
      )}
    </div>
  );
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
    default:
      return 'The sync service refused the connection. Edits are held on this device.';
  }
}
