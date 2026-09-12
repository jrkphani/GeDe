import clsx from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import {
  addColumn,
  addRow,
  assignPresenceColour,
  cellAddress,
  clearCell,
  createSheet,
  createTable,
  LATTICE,
  listSheets,
  setCellText,
  sheetBounds,
  tableById,
  tableMap,
  tablesOnSheet,
  tableUnitBounds,
  toPresenceState,
  unitBoundsToPx,
  type Id,
  type PresenceColour,
  type PresenceState,
} from '@gede/core';
import { below, theme } from '@gede/tokens';
import { Banner, Button, Skeleton } from '@gede/ui';

import { announce } from '../../announce.js';
import { canEdit, getDocument, type DocumentSummary } from '../../api/documents.js';
import { rememberLastDocument, useSession } from '../../auth/session.js';
import { CHORDS, LABELS, useShortcuts, type ShortcutBinding } from '../../doc/shortcuts.js';
import {
  CLOSE_FORBIDDEN,
  CLOSE_NOT_FOUND,
  CLOSE_UNAUTHENTICATED,
  type SyncSnapshot,
} from '../../doc/sync-client.js';
import { useDocument, type DocumentSession, type ReplicaState } from '../../doc/use-document.js';
import { useAwarenessVersion, useYVersion } from '../../doc/use-y.js';
import {
  centre,
  clampViewport,
  fitViewport,
  INITIAL_VIEWPORT,
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
import { Inspector } from './Inspector.js';
import { selectedCell, type CellSelection, type Selection } from './selection.js';
import { SheetTabs } from './SheetTabs.js';
import { TableView } from './TableView.js';
import { TitleBar } from './TitleBar.js';
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
  const { session, sync, ready, replica } = useDocument(id, { seed });

  if (load.status === 'error') throw load.error;

  const editable = !phone && doc !== null && canEdit(doc);

  if (doc === null || session === null) {
    return (
      <div className={clsx('gd-doc', { 'gd-doc--phone': phone })}>
        <div className="gd-doc__loading">
          <Skeleton active rows={8} statusLabel="Loading workscape" className="gd-doc__skeleton" />
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
      replica={replica}
      phone={phone}
      editable={editable}
      focusTitle={params.get('new') === '1'}
    />
  );
}

interface OpenDocumentProps {
  doc: DocumentSummary;
  session: DocumentSession;
  sync: SyncSnapshot;
  ready: boolean;
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
  replica,
  phone,
  editable,
  focusTitle,
}: OpenDocumentProps) {
  const { gd } = session;
  const { state: sessionState } = useSession();
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
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editing, setEditing] = useState<CellSelection | null>(null);
  const [viewport, setViewport] = useState<Viewport>(INITIAL_VIEWPORT);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [gridlines, setGridlines] = useState(true);
  const [inspector, setInspector] = useState<InspectorMode | null>(() => (wide ? 'format' : null));
  const [renameError, setRenameError] = useState<string | null>(null);

  const tables = activeSheetId === null ? [] : tablesOnSheet(gd, activeSheetId);
  const selectedTable = selection === null ? null : tableById(gd, selection.tableId);
  const cell = useMemo(() => selectedCell(selection), [selection]);
  const tier = zoomTier(viewport.zoom);

  // -- presence ---------------------------------------------------------------
  const colour = useRef<PresenceColour | null>(null);
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
    if (user === null) return;
    colour.current ??= assignPresenceColour(others.map((o) => o.colour));
    const state: PresenceState = {
      userId: user.sub,
      name: user.name ?? user.email,
      colour: colour.current,
      sheetId: activeSheetId,
      cell: cell ?? undefined,
    };
    session.sync.awareness.setLocalState(state);
    // `others` is derived from awareness itself and deliberately not a dependency: it would loop.
  }, [session, user, activeSheetId, cell?.tableId, cell?.rowId, cell?.colId]);
  const onSheet = useMemo(
    () => others.filter((o) => o.sheetId === activeSheetId),
    [others, activeSheetId],
  );

  // -- selection --------------------------------------------------------------
  const selectCell = useCallback(
    (next: CellSelection) => {
      setEditing((e) =>
        e !== null && (e.rowId !== next.rowId || e.colId !== next.colId) ? null : e,
      );
      setSelection({ tableId: next.tableId, cell: { rowId: next.rowId, colId: next.colId } });
      const table = tableMap(gd, next.tableId);
      const address = table === null ? null : cellAddress(table, next.rowId, next.colId);
      const title = table === null ? '' : (tableById(gd, next.tableId)?.title ?? '');
      announce(
        address === null ? `Selected a cell in ${title}` : `Selected ${address} in ${title}`,
      );
    },
    [gd],
  );
  const selectTable = useCallback(
    (tableId: Id) => {
      setEditing(null);
      setSelection({ tableId, cell: null });
      announce(`Selected ${tableById(gd, tableId)?.title ?? 'table'}`);
    },
    [gd],
  );
  const clearSelection = useCallback(() => {
    setEditing(null);
    setSelection((s) => {
      if (s !== null) announce('Selection cleared');
      return null;
    });
  }, []);

  // -- sheets (DOC-03) --------------------------------------------------------
  const selectSheet = useCallback(
    (sheetId: Id) => {
      setChosenSheetId(sheetId);
      setSelection(null);
      setEditing(null);
      setViewport((v) => ({ x: 0, y: 0, zoom: v.zoom }));
      const sheet = listSheets(gd).find((s) => s.id === sheetId);
      if (sheet !== undefined) announce(`Sheet ${String(sheet.ordinal)}, ${sheet.label}`);
    },
    [gd],
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
    if (selection === null || !editable) return;
    const rowId = addRow(gd, selection.tableId);
    const record = tableById(gd, selection.tableId);
    const firstCol = record?.columns[0]?.id;
    if (firstCol !== undefined) selectCell({ tableId: selection.tableId, rowId, colId: firstCol });
  }, [gd, selection, editable, selectCell]);
  const addColumnToSelected = useCallback(() => {
    if (selection === null || !editable) return;
    const colId = addColumn(gd, selection.tableId);
    const record = tableById(gd, selection.tableId);
    const firstRow = record?.rows[0];
    if (firstRow !== undefined) selectCell({ tableId: selection.tableId, rowId: firstRow, colId });
  }, [gd, selection, editable, selectCell]);
  const commitCell = useCallback(
    (target: CellSelection, text: string) => {
      if (!editable) return;
      setCellText(gd, target.tableId, target.rowId, target.colId, text);
    },
    [gd, editable],
  );
  const clearSelectedCell = useCallback(
    (target: CellSelection) => {
      if (!editable) return;
      clearCell(gd, target.tableId, target.rowId, target.colId);
    },
    [gd, editable],
  );
  const editCell = useCallback(
    (target: CellSelection | null) => {
      if (!editable) return;
      setEditing(target);
    },
    [editable],
  );

  // -- keyboard (KEYS-07, KEYS-06 subset) ------------------------------------
  const bindings: ShortcutBinding[] = [
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
        sync={sync}
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
        />
      )}

      <div className="gd-doc__banners">
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
        {failure !== null && (
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
          rows={8}
          statusLabel="Loading workscape"
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
                  editingCell={editing !== null && editing.tableId === t.id ? editing : null}
                  editable={editable}
                  presence={onSheet}
                  onSelectCell={selectCell}
                  onSelectTable={selectTable}
                  onEditCell={editCell}
                  onCommitCell={commitCell}
                  onClearCell={clearSelectedCell}
                  onAddRow={addRowToSelected}
                  onAddColumn={addColumnToSelected}
                />
              );
            })}
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
    case CLOSE_UNAUTHENTICATED:
      return 'Your session ended. Sign in again to keep syncing; edits are held on this device.';
    case CLOSE_FORBIDDEN:
      return 'You no longer have access to this workscape. Edits are held on this device.';
    case CLOSE_NOT_FOUND:
      return 'This workscape was deleted. Anything deleted in the last 30 days can be recovered from Recently Deleted.';
    default:
      return 'The sync service refused the connection. Edits are held on this device.';
  }
}
