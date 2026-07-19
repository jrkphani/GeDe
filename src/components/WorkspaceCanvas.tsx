import { useCallback, useEffect, useMemo, useRef, type FocusEvent } from 'react'
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Node,
  type NodeProps,
  type OnNodeDrag,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  computeLaneLayout,
  LANE_ORDER,
  type LaneItem,
  type LaneLayoutConfig,
} from '../domain/laneLayout'
import { useActiveLaneStore } from '../store/activeLane'
import { canWrite } from '../domain/workspaceRole'
import { useTier2Store } from '../store/tier2'
import { useWorkspaceRole } from '../store/workspace'
import type { Tier2TableRow } from '../db/mutations'
import type { AppRoute, DesignView } from '../shell/routes'
import { DesignSurface } from './DesignSurface'
import { firstEditableCell, lastEditablePosition } from './gridBoundaryFocus'
import { FoundationSurface } from './FoundationSurface'
import { TablePanel } from './ArchitectureSurface'
import { PhantomInput } from './ui/inline-editor'
// The ⌘1/2/3 pan-to-lane interceptor + its module-level `activeCanvasInstance`
// handle live in this tiny, `@xyflow/react`-free module so App.tsx can import
// THEM eagerly (register the listener before AppShell) while `React.lazy`-loading
// this heavy canvas — keeping React Flow's JS AND its stylesheet out of prod.
import {
  clearActiveCanvasInstance,
  LANE_NODE_ID,
  prefersReducedMotion,
  setActiveCanvasInstance,
  type CanvasNavInstance,
} from './d3CanvasNav'

// 089-D3 P3.2 — DECOMPOSE the Architecture lane into per-table nodes. Where P2
// mounted each tier as ONE whole-surface node, the Architecture column now emits
// one React Flow node PER `tier2` table (id = table id), each hosting the REAL
// `TablePanel` (its EditableGrid + tree/promote/resolution), plus a small header
// node (heading + the add-table phantom + empty-state) at the top of the column.
// Foundation and Design stay whole-surface nodes for now. Every node's position
// is DERIVED by P0's `computeLaneLayout` (STYLE_GUIDE §1 principle 4 / SPEC
// invariant 5 — a pure projection of `(tier, sort)`, never persisted): x is
// tier-indexed (LANE_ORDER), and within the Architecture column the header (sort
// -1) then the tables (sort 0..n-1) stack downward using each node's MEASURED
// pixel height (React Flow v12 `node.measured.height`), with a per-tier estimate
// seeding the first frame before measurement lands.
//
// Mounted ONLY behind the dev-only `?d3rf` flag (App.tsx, DEV build) — the normal
// app still renders `WorkspaceSurface`. P3.2 is the structure; P3.3 (below) is
// cross-node Tab; node-DRAG → the real `sort` mutation is the next phase (P3.4),
// so the header handle stays a visual no-op reorder gesture for now.
//
// Spike-proven annotations that are load-bearing (all node kinds):
//   • each node's interactive body is `nodrag nopan nowheel` — else a pointerdown
//     starts a node-drag instead of a cell edit (`nodrag`), and a wheel zooms the
//     canvas instead of scrolling the cell (`nowheel`);
//   • each node carries a header `dragHandle` (`.wc-node__handle`) so the ONLY
//     drag origin is the header, never a grid body (belt-and-suspenders);
//   • `autoPanOnNodeDrag={false}` — the viewport must not chase a dragged node;
//   • each body records its tier on the D2 `activeLane` slice on focus/pointer so
//     Design's `c`/`v`/`d` capture-phase verbs stay lane-scoped.

type WorkspaceRoute = Extract<AppRoute, { kind: 'project' | 'tier' | 'design' }>

// Estimated node heights for the derived layout's FIRST frame — used only until
// React Flow measures each node (`node.measured.height`) and the stack is
// re-derived. Kept honest so the pre-measurement paint is roughly right (Design
// is the tallest tier; a table is a short panel; the header is tiny).
const FOUNDATION_ESTIMATE = 700
const DESIGN_ESTIMATE = 1200
const ARCH_HEADER_ESTIMATE = 160
const ARCH_TABLE_ESTIMATE = 340

// Human label on the Foundation / Design header drag-handle bars.
const LANE_LABEL: Record<'foundation' | 'design', string> = {
  foundation: 'Foundation',
  design: 'Design',
}

// Lane geometry. `laneWidth` matches the `.wc-node` reading width so the real
// surfaces lay out identically inside their nodes; each column's x is a pure
// function of its tier index (LANE_ORDER).
const LANE_CONFIG: LaneLayoutConfig = { laneWidth: 960, laneGap: 48, nodeGap: 24 }

// The derived x of the Architecture lane column (a pure fn of its tier index —
// identical to laneLayout's own `laneX`). A table-node drag is pinned to this x
// so the lane stays a clean vertical column: only the drag's y (its `sort`
// slot) ever carries meaning, never its x (P3.4 constrained-drag reorder).
const ARCH_COLUMN_X =
  LANE_ORDER.indexOf('architecture') * (LANE_CONFIG.laneWidth + LANE_CONFIG.laneGap)

const FOCUS_PAN_DURATION = 320
// Focus-driven pan is pan-if-outside-margin, NOT center-on-every-focus: only
// pan when the focused element is within this many px of (or past) a pane edge,
// so the viewport never fights a typist whose caret is already comfortably in
// view (D3 spike finding — "center on every focus is too jerky").
const FOCUS_PAN_MARGIN = 88

// ── Node data shapes (a `type`, not `interface`, so each satisfies React Flow's
// `Record<string, unknown>` Data constraint — interfaces lack the implicit index
// signature). Every shape carries `tier`/`sort`/`estimate` so one layout helper
// can derive positions across all node kinds. eslint's consistent-type-
// definitions is waived for that reason. ────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type LaneNodeData = {
  tier: 'foundation' | 'design'
  sort: number
  estimate: number
  projectId: string
  contextPath: string[]
  view: DesignView
  canvasId: string | undefined
}
type LaneNode = Node<LaneNodeData, 'lane'>

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type ArchHeaderData = {
  tier: 'architecture'
  sort: number
  estimate: number
  readOnly: boolean
  // Continue focus into a freshly-created table's node once it mounts.
  onTableCreated: (tableId: string) => void
}
type ArchHeaderNode = Node<ArchHeaderData, 'archHeader'>

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type ArchTableData = {
  tier: 'architecture'
  sort: number
  estimate: number
  projectId: string
  table: Tier2TableRow
  readOnly: boolean
  // Cross-node Tab (P3.3): the grid hit a forward/backward boundary — relocate
  // focus to the next/prev-by-`sort` table node.
  onExitBoundary: (tableId: string, dir: 'forward' | 'backward') => void
}
type ArchTableNode = Node<ArchTableData, 'archTable'>

type CanvasNode = LaneNode | ArchHeaderNode | ArchTableNode

// ── Cross-node focus helpers (P3.3). A table node's DOM is `.react-flow__node
// [data-id="<tableId>"]`; within it we land focus on the FIRST editable grid
// cell (forward entry) or the LAST editable position — the phantom "add entry"
// row (backward entry). Focusing an off-screen target trips the wrapper's
// `onFocusCapture` pan, bringing it on-screen (spike gate-d). `firstEditableCell`
// / `lastEditablePosition` now live in the shared `gridBoundaryFocus` seam module
// (084-D3 P0) so this consumer and the 084 Architecture chain adapter share one
// set of edge semantics. ─────────────────────────────────────────────────────

function nodeElement(tableId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.react-flow__node[data-id="${tableId}"]`)
}

// ── The derived-position projection. Reads each node's MEASURED height (or its
// seed estimate before measurement) and re-derives every node's {x,y} via
// computeLaneLayout. Returns the SAME array reference when nothing moved so it
// can be called from a measurement effect without churning. ──────────────────
function withDerivedPositions(nodes: CanvasNode[]): CanvasNode[] {
  const items: LaneItem[] = nodes.map((n) => ({
    id: n.id,
    tier: n.data.tier,
    sort: n.data.sort,
    height: n.measured?.height ?? n.data.estimate,
  }))
  const posById = new Map(computeLaneLayout(items, LANE_CONFIG).map((p) => [p.id, p]))
  const next = nodes.map((n) => {
    const p = posById.get(n.id)
    if (!p || (n.position.x === p.x && n.position.y === p.y)) return n
    return { ...n, position: { x: p.x, y: p.y } }
  })
  // Same reference when nothing moved, so a measurement effect can call this
  // without churning node identity (mirrors the P2 re-sync guard).
  return next.some((n, i) => n !== nodes[i]) ? next : nodes
}

// ── Node components ──────────────────────────────────────────────────────────

// Foundation / Design lane node: a header drag-handle bar over the REAL whole
// tier surface. Body is `nodrag nopan nowheel` and records its lane active on
// focus/pointer (D2 `activeLane` gating).
function LaneNode({ data }: NodeProps<LaneNode>) {
  const setActiveLane = useActiveLaneStore((s) => s.setActiveLane)
  const { tier } = data
  return (
    <div className={`wc-node wc-node--${tier}`}>
      <div className="wc-node__handle" aria-hidden="true">
        {LANE_LABEL[tier]}
      </div>
      <div
        className="nodrag nopan nowheel wc-node__body"
        onFocusCapture={() => setActiveLane(tier)}
        onPointerDown={() => setActiveLane(tier)}
      >
        {tier === 'foundation' && <FoundationSurface projectId={data.projectId} />}
        {tier === 'design' && (
          <DesignSurface
            projectId={data.projectId}
            contextPath={data.contextPath}
            view={data.view}
            canvasId={data.canvasId}
          />
        )}
      </div>
    </div>
  )
}

// Architecture column header node: the heading + the single add-table phantom
// (the one create path, issue 084) + the empty-state line. Carries the
// Architecture lane's stable node id (LANE_NODE_ID.architecture) so ⌘2 frames
// the column top. Adding a table continues focus into the new node (rAF×2).
function ArchHeaderNode({ data }: NodeProps<ArchHeaderNode>) {
  const setActiveLane = useActiveLaneStore((s) => s.setActiveLane)
  const tables = useTier2Store((s) => s.tables)
  const addTable = useTier2Store((s) => s.addTable)
  return (
    <div className="wc-node wc-node--architecture wc-node--arch-header">
      <div className="wc-node__handle" aria-hidden="true">
        Architecture
      </div>
      <div
        className="nodrag nopan nowheel wc-node__body"
        onFocusCapture={() => setActiveLane('architecture')}
        onPointerDown={() => setActiveLane('architecture')}
      >
        <h2 className="tier2-header">2nd Tier · Architecture</h2>
        {data.readOnly ? null : (
          <div className="t2-add-table">
            <span className="t2-add-table__glyph" aria-hidden>
              +
            </span>
            <PhantomInput
              placeholder="Name a table"
              ariaLabel="Add architecture table"
              inputClassName="t2-add-table__input"
              onSubmit={(name) =>
                void addTable(name).then((row) => {
                  if (row) data.onTableCreated(row.id)
                })
              }
            />
          </div>
        )}
        {tables.length === 0 && !data.readOnly ? (
          <p className="t2-empty">
            No tables yet. Name your first dimension above — e.g. “Stakeholders”, “Value”.
          </p>
        ) : null}
      </div>
    </div>
  )
}

// Per-table Architecture node: a header drag-handle bar (the table name) over
// the REAL `TablePanel`. `data-table-id` makes the node addressable for the
// cross-node focus helpers above; `onExitBoundary` wires the grid's Tab-off-a-
// -boundary seam to the canvas's next/prev-by-`sort` traversal.
function ArchTableNode({ data }: NodeProps<ArchTableNode>) {
  const setActiveLane = useActiveLaneStore((s) => s.setActiveLane)
  return (
    <div className="wc-node wc-node--arch-table" data-table-id={data.table.id}>
      <div className="wc-node__handle" aria-hidden="true">
        {data.table.name}
      </div>
      <div
        className="nodrag nopan nowheel wc-node__body"
        onFocusCapture={() => setActiveLane('architecture')}
        onPointerDown={() => setActiveLane('architecture')}
      >
        <TablePanel
          projectId={data.projectId}
          table={data.table}
          readOnly={data.readOnly}
          onExitBoundary={(dir) => data.onExitBoundary(data.table.id, dir)}
        />
      </div>
    </div>
  )
}

// Stable across renders — React Flow warns (and remounts nodes) if nodeTypes is
// a fresh object each render.
const NODE_TYPES = { lane: LaneNode, archHeader: ArchHeaderNode, archTable: ArchTableNode }

// The exported shell wraps the canvas in a ReactFlowProvider so both the
// imperative viewport handle (`useReactFlow`, for ⌘1/2/3 pan-to-lane + focus-pan)
// and `useNodesInitialized` live inside the RF context.
export function WorkspaceCanvas({ route }: { route: WorkspaceRoute }) {
  return (
    <ReactFlowProvider>
      <WorkspaceCanvasInner route={route} />
    </ReactFlowProvider>
  )
}

// A STABLE empty contextPath for non-`design` routes. A fresh `[]` literal here
// would give `design.contextPath` a new identity every render, so the
// `desiredNodes` useMemo (which depends on it) would recompute every render and
// its reconcile effect would `setNodes` in a loop → "Maximum update depth". This
// only manifests once the canvas STAYS mounted on a non-design route — which the
// 089-P0 flag-persistence (canvasMode) first made possible (pre-P0 an in-app
// navigate to a tier route dropped `?d3rf` and unmounted the canvas, masking it).
const NO_CONTEXT_PATH: string[] = []

function WorkspaceCanvasInner({ route }: { route: WorkspaceRoute }) {
  const projectId = route.projectId
  // Same derivation as WorkspaceSurface: only a `design` route carries
  // contextPath / view / canvasId; other workspace routes open the root canvas.
  const design =
    route.kind === 'design'
      ? { contextPath: route.contextPath, view: route.view, canvasId: route.canvasId }
      : { contextPath: NO_CONTEXT_PATH, view: 'canvas' as const, canvasId: undefined }

  // The decomposed Architecture column is data-driven off the tier2 store: in
  // the flag-off app `ArchitectureSurface` calls `load` itself, but here it never
  // mounts, so the canvas owns the load + drives one node per table.
  const tables = useTier2Store((s) => s.tables)
  useEffect(() => {
    void useTier2Store.getState().load(projectId)
  }, [projectId])

  const { role } = useWorkspaceRole(projectId)
  const readOnly = !canWrite(role)

  const reactFlow = useReactFlow<CanvasNode>()

  // Latest tables in a ref so the (stable) boundary callback reads current sort
  // order without re-subscribing. `tables` is DB-ordered by `sort` ascending.
  const tablesRef = useRef(tables)
  tablesRef.current = tables

  // P3.2 — continue focus into a just-created table's node. The store update →
  // node build → React Flow mount → measure chain needs two frames to settle
  // before the new node's grid exists in the DOM (spike's rAF×2 mount race).
  const onTableCreated = useCallback((tableId: string) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const node = nodeElement(tableId)
        if (node) firstEditableCell(node)?.focus()
      }),
    )
  }, [])

  // P3.3 — cross-node Tab. The grid fired a boundary handoff (after it committed
  // any in-flight edit, via the P3.0 `onExitBoundary` seam): move focus to the
  // next-by-`sort` (forward) or prev-by-`sort` (backward) table node. Traversal
  // follows the store's `sort` order — NOT DOM/array order — exactly as the spike
  // required (native Tab desyncs from `sort` after a reorder). One frame lets the
  // grid's own commit/close settle before we relocate; focusing the target trips
  // the wrapper's focus-pan if it is off-screen.
  const onTableExitBoundary = useCallback((tableId: string, dir: 'forward' | 'backward') => {
    const list = tablesRef.current
    const idx = list.findIndex((t) => t.id === tableId)
    if (idx === -1) return
    const target = dir === 'forward' ? list[idx + 1] : list[idx - 1]
    if (!target) return
    requestAnimationFrame(() => {
      const node = nodeElement(target.id)
      if (!node) return
      const cell = dir === 'forward' ? firstEditableCell(node) : lastEditablePosition(node)
      cell?.focus()
    })
  }, [])

  // The desired node set for the current tables + route + role. Foundation and
  // Design stay whole-surface `lane` nodes; the Architecture column is the header
  // node (sort -1) + one `archTable` node per table (sort = table.sort). Node
  // (DOM) order is intentionally DECOUPLED from visual `sort` order — the table
  // nodes are emitted in DESCENDING sort so DOM/array order ≠ visual/stack order.
  // This is legitimate (React Flow renders by array order, positions by `sort`)
  // and it hardens the P3.3 invariant: cross-node Tab must follow `sort`, not the
  // DOM, and the e2e proves it against a DOM whose order is the reverse (a stand-
  // in for the sort≠creation-order divergence P3.4's drag-reorder will produce).
  const desiredNodes = useMemo<CanvasNode[]>(() => {
    const list: CanvasNode[] = [
      {
        id: LANE_NODE_ID.foundation,
        type: 'lane',
        position: { x: 0, y: 0 },
        dragHandle: '.wc-node__handle',
        data: {
          tier: 'foundation',
          sort: 0,
          estimate: FOUNDATION_ESTIMATE,
          projectId,
          contextPath: [],
          view: 'canvas',
          canvasId: undefined,
        },
      },
      {
        id: LANE_NODE_ID.architecture,
        type: 'archHeader',
        position: { x: 0, y: 0 },
        dragHandle: '.wc-node__handle',
        data: {
          tier: 'architecture',
          sort: -1,
          estimate: ARCH_HEADER_ESTIMATE,
          readOnly,
          onTableCreated,
        },
      },
      {
        id: LANE_NODE_ID.design,
        type: 'lane',
        position: { x: 0, y: 0 },
        dragHandle: '.wc-node__handle',
        data: {
          tier: 'design',
          sort: 0,
          estimate: DESIGN_ESTIMATE,
          projectId,
          contextPath: design.contextPath,
          view: design.view,
          canvasId: design.canvasId,
        },
      },
    ]
    for (const table of [...tables].reverse()) {
      list.push({
        id: table.id,
        type: 'archTable',
        position: { x: 0, y: 0 },
        dragHandle: '.wc-node__handle',
        data: {
          tier: 'architecture',
          sort: table.sort,
          estimate: ARCH_TABLE_ESTIMATE,
          projectId,
          table,
          readOnly,
          onExitBoundary: onTableExitBoundary,
        },
      })
    }
    return list
  }, [
    tables,
    projectId,
    design.contextPath,
    design.view,
    design.canvasId,
    readOnly,
    onTableCreated,
    onTableExitBoundary,
  ])

  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(desiredNodes)

  // Reconcile the mounted nodes with the desired set whenever tables/route/role
  // change: refresh each node's `data` (so a project switch, a design drill-down,
  // or a table rename flows through) while CARRYING OVER React Flow's measured
  // dimensions, then re-derive every position. Added tables mount; removed tables
  // unmount; no position is ever persisted.
  useEffect(() => {
    setNodes((prev) => {
      const measuredById = new Map(prev.map((n) => [n.id, n.measured]))
      const merged = desiredNodes.map((d) => {
        const measured = measuredById.get(d.id)
        return measured ? { ...d, measured } : d
      })
      return withDerivedPositions(merged)
    })
  }, [desiredNodes, setNodes])

  // Re-derive the stack whenever any node's MEASURED height changes (React Flow
  // v12 sets `node.measured` after layout; the first frame used estimates). Keyed
  // on a measurement signature so it fires exactly when heights settle — and
  // `withDerivedPositions` returns the same array when nothing moved, so this
  // never loops.
  const measuredSignature = nodes
    .map((n) => `${n.id}:${Math.round(n.measured?.height ?? 0)}`)
    .join('|')
  useEffect(() => {
    setNodes((prev) => withDerivedPositions(prev))
  }, [measuredSignature, setNodes])

  // fitView-vs-measurement race (spike gate-e): the `fitView` prop can frame the
  // pre-measurement estimate layout. Once every node has been measured
  // (`useNodesInitialized`), refit ONCE against the settled positions so nothing
  // is off-screen on first paint. Guarded so a later table-add (which briefly
  // re-initializes) never yanks the viewport out from under the user.
  const nodesInitialized = useNodesInitialized()
  const didInitialFit = useRef(false)
  useEffect(() => {
    if (!nodesInitialized || didInitialFit.current) return
    didInitialFit.current = true
    const raf = requestAnimationFrame(() => void reactFlow.fitView({ padding: 0.12, duration: 0 }))
    return () => cancelAnimationFrame(raf)
  }, [nodesInitialized, reactFlow])

  // The pane wrapper — its rect is the on-screen viewport bounds the focus-pan
  // margin test is measured against.
  const wrapperRef = useRef<HTMLDivElement>(null)

  // ⌘1/2/3 → pan/zoom to the Foundation / Architecture / Design lane node. The
  // key listener is the MODULE-LEVEL interceptor in `./d3CanvasNav` (registered
  // eagerly by App.tsx); this effect publishes this canvas's live React Flow
  // instance as the active pan target while mounted, and clears it on unmount.
  useEffect(() => {
    const nav: CanvasNavInstance = { fitView: (options) => reactFlow.fitView(options) }
    setActiveCanvasInstance(nav)
    return () => clearActiveCanvasInstance(nav)
  }, [reactFlow])

  // Focus-driven pan (D3 spike gate-d): native `scrollIntoView` is a no-op on a
  // transformed plane, so focusing a cell/editor inside a node needs an explicit
  // pan. Heuristic is pan-if-outside-margin, never center-on-every-focus: only
  // when the focused element is near/past a pane edge do we `setCenter` on it,
  // keeping the CURRENT zoom (pan, don't re-zoom). Reduced-motion snaps. This is
  // also what brings a cross-node-Tab target on-screen (P3.3).
  const onFocusCapture = useCallback(
    (e: FocusEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null
      const pane = wrapperRef.current
      if (!target || !pane || typeof target.getBoundingClientRect !== 'function') return
      const r = target.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) return
      const p = pane.getBoundingClientRect()
      const outside =
        r.top < p.top + FOCUS_PAN_MARGIN ||
        r.bottom > p.bottom - FOCUS_PAN_MARGIN ||
        r.left < p.left + FOCUS_PAN_MARGIN ||
        r.right > p.right - FOCUS_PAN_MARGIN
      if (!outside) return
      const center = reactFlow.screenToFlowPosition({
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
      })
      const { zoom } = reactFlow.getViewport()
      const duration = prefersReducedMotion() ? 0 : FOCUS_PAN_DURATION
      void reactFlow.setCenter(center.x, center.y, { zoom, duration })
    },
    [reactFlow],
  )

  // P3.4 — constrained table-node drag. During the drag, pin the dragged table's
  // x to the Architecture column (honoring its LIVE dragged y) so the lane never
  // drifts sideways — the drag reads as a pure vertical reorder gesture. Only
  // `archTable` nodes reorder; other node kinds drag freely and snap back on stop.
  const onNodeDrag = useCallback<OnNodeDrag<CanvasNode>>(
    (_event, node) => {
      if (node.type !== 'archTable') return
      setNodes((prev) =>
        prev.map((n) =>
          n.id === node.id && n.position.x !== ARCH_COLUMN_X
            ? { ...n, position: { x: ARCH_COLUMN_X, y: node.position.y } }
            : n,
        ),
      )
    },
    [setNodes],
  )

  // P3.4 — on drop: for a table node, compute its new lane index from its drop
  // center-y ranked against its siblings' slot centers, then PERSIST the reorder
  // via the tier2 store (which rewrites ONLY `sort`, never a `{x,y}`). Always
  // re-derive EVERY node's position afterward so the dropped node snaps to its
  // derived slot — no node ever keeps its dragged coords (derived-positioning
  // invariant). Foundation/Design/header drags are pure no-ops: they just snap
  // back.
  const onNodeDragStop = useCallback<OnNodeDrag<CanvasNode>>(
    (_event, node) => {
      if (node.type === 'archTable') {
        const archNodes = reactFlow.getNodes().filter((n) => n.type === 'archTable')
        // Rank every table node by its center-y (the dragged node using its live
        // dropped y, siblings their derived y); the dragged node's rank is the
        // index it now occupies — exactly what reorderTier2Table densifies to.
        const ranked = archNodes
          .map((n) => {
            const y = n.id === node.id ? node.position.y : n.position.y
            const height = n.measured?.height ?? n.data.estimate
            return { id: n.id, center: y + height / 2 }
          })
          .sort((a, b) => a.center - b.center)
        const targetIndex = ranked.findIndex((r) => r.id === node.id)
        if (targetIndex !== -1) void useTier2Store.getState().reorderTable(node.id, targetIndex)
      }
      setNodes((prev) => withDerivedPositions(prev))
    },
    [reactFlow, setNodes],
  )

  return (
    <div className="workspace-canvas" ref={wrapperRef} onFocusCapture={onFocusCapture}>
      <ReactFlow
        nodes={nodes}
        onNodesChange={onNodesChange}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        nodeTypes={NODE_TYPES}
        // Frame everything into the pane on first paint; the post-measurement
        // effect above refits once measured heights settle (fit-vs-measure race).
        fitView
        fitViewOptions={{ padding: 0.12 }}
        minZoom={0.2}
        maxZoom={2}
        nodesConnectable={false}
        autoPanOnNodeDrag={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
