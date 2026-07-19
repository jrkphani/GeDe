import { useCallback, useEffect, useMemo, useRef, type FocusEvent } from 'react'
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Edge,
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
import {
  computeSatelliteLayout,
  type ClusterLayoutConfig,
  type SatelliteItem,
} from '../domain/clusterLayout'
import { navigate } from '../shell/router'
import {
  resetCanvasSatellites,
  satelliteNodeId,
  useCanvasSatellitesStore,
} from '../store/canvasSatellites'
import { useContextsStore } from '../store/contexts'
import { useActiveLaneStore } from '../store/activeLane'
import { canWrite } from '../domain/workspaceRole'
import { formatDegree } from '../domain/degree'
import { useTier1Store } from '../store/tier1'
import { useTier2Store } from '../store/tier2'
import { useWorkspaceRole } from '../store/workspace'
import type { Tier1PropRow, Tier2TableRow } from '../db/mutations'
import type { AppRoute, DesignView } from '../shell/routes'
import { DesignRegisterBody, DesignRingBody } from './DesignCoreAdapter'
import { firstEditableCell, lastEditablePosition } from './gridBoundaryFocus'
import { FoundationHeaderPanel, FoundationPropPanel } from './FoundationCanvasNodes'
import { TablePanel } from './ArchitectureSurface'
import { Button } from './ui/button'
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

// 089-D3 P3.2 / P1 — DECOMPOSE the tier lanes into per-item nodes. Where earlier
// P2 mounted each tier as ONE whole-surface node, the Architecture column emits
// one React Flow node PER `tier2` table (id = table id), each hosting the REAL
// `TablePanel` (its EditableGrid + tree/promote/resolution), plus a small header
// node (heading + the add-table phantom + empty-state) at the top of the column;
// the Foundation column (graduation P1) is decomposed the same way — a header
// node (heading + Purpose/Existing-Scenario + add-prop phantom) + one node per
// `tier1_props` value-prop (its name/description grid) — the one difference being
// Foundation reorders by RANK (`reorderProp`), not `sort`. The Design lane (P2) is
// a register node (rail + ContextRegister + header) stacked over a ring node
// (Canvas), sharing the compose draft via the `canvasCompose` store. Every node's
// position is DERIVED by P0's `computeLaneLayout` (STYLE_GUIDE §1 principle 4 / SPEC
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
const FOUNDATION_HEADER_ESTIMATE = 620
const FOUNDATION_ITEM_ESTIMATE = 120
// The Design lane is decomposed (P2) into a register node (rail + ContextRegister
// + header) stacked over a ring node (Canvas). Two estimates for the first frame.
const DESIGN_REGISTER_ESTIMATE = 720
const DESIGN_RING_ESTIMATE = 560
// Stable node id for the ring (the register keeps LANE_NODE_ID.design so ⌘3 still
// frames the Design column top).
const DESIGN_RING_NODE_ID = 'workspace-canvas-design-ring'
const ARCH_HEADER_ESTIMATE = 160
const ARCH_TABLE_ESTIMATE = 340

// Lane geometry. `laneWidth` matches the `.wc-node` reading width so the real
// surfaces lay out identically inside their nodes; each column's x is a pure
// function of its tier index (LANE_ORDER).
const LANE_CONFIG: LaneLayoutConfig = { laneWidth: 960, laneGap: 48, nodeGap: 24 }

// The derived x of a lane column (a pure fn of its tier index — identical to
// laneLayout's own `laneX`). A per-item-node drag is pinned to its lane's x so
// the lane stays a clean vertical column: only the drag's y (its rank/sort slot)
// ever carries meaning, never its x (constrained-drag reorder).
const laneColumnX = (tier: 'foundation' | 'architecture') =>
  LANE_ORDER.indexOf(tier) * (LANE_CONFIG.laneWidth + LANE_CONFIG.laneGap)
const FOUNDATION_COLUMN_X = laneColumnX('foundation')
const ARCH_COLUMN_X = laneColumnX('architecture')

// 089-D3 P3 — the recursion cluster geometry (issue 011). A drill-in opens a
// context's child canvas as a SUMMARY satellite node to the RIGHT of the Design
// column, connected by a parent→child edge. Satellites stack in one column, one
// laneWidth + coreGap to the right of the Design core, so they clear even a
// 093-widened register; SATELLITE_ESTIMATE seeds the fixed summary-card height.
// The Design column's x = its LANE_ORDER index × the column stride.
const DESIGN_COLUMN_X = LANE_ORDER.indexOf('design') * (LANE_CONFIG.laneWidth + LANE_CONFIG.laneGap)
const SATELLITE_ESTIMATE = 168
// Base cluster geometry; `coreWidth` is overridden per-derive with the register's
// MEASURED width (see withDerivedPositions) so satellites clear a 093-widened
// (max-content, uncapped) register instead of overlapping it.
const CLUSTER_CONFIG: ClusterLayoutConfig = {
  originX: DESIGN_COLUMN_X,
  coreWidth: LANE_CONFIG.laneWidth,
  coreGap: 120,
  satelliteHeight: SATELLITE_ESTIMATE,
  vGap: LANE_CONFIG.nodeGap,
}

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
type DesignBodyNodeData = {
  // P2 decomposed Design into a register node stacked over a ring node. Both
  // carry the same route-derived data; the node TYPE picks which body renders.
  tier: 'design'
  sort: number
  estimate: number
  projectId: string
  contextPath: string[]
  view: DesignView
  canvasId: string | undefined
}
type DesignRegisterNode = Node<DesignBodyNodeData, 'designRegister'>
type DesignRingNode = Node<DesignBodyNodeData, 'designRing'>

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type FoundationHeaderData = {
  tier: 'foundation'
  sort: number
  estimate: number
  readOnly: boolean
  // Continue focus into a freshly-created value-prop's node once it mounts.
  onPropCreated: (propId: string) => void
}
type FoundationHeaderNode = Node<FoundationHeaderData, 'foundationHeader'>

// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type FoundationItemData = {
  tier: 'foundation'
  sort: number
  estimate: number
  prop: Tier1PropRow
  readOnly: boolean
  // Cross-node Tab: the grid hit a forward/backward boundary — relocate focus to
  // the next/prev-by-`sort` value-prop node (mirrors ArchTable's onExitBoundary).
  onExitBoundary: (propId: string, dir: 'forward' | 'backward') => void
}
type FoundationItemNode = Node<FoundationItemData, 'foundationItem'>

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

// 089-D3 P3 — a recursion SATELLITE node: the SUMMARY of a context's child canvas
// (issue 011), opened to the right of the Design core + connected by an edge. NOT
// a live {register+ring} core (the contexts store is a singleton — promoting a
// stub to a live core is the tracked 089 follow-up); it shows the parent symbol +
// child-context count, reads them itself from the contexts store, and offers
// Enter ▸ (navigate deep — the existing drill) and Collapse ×. It has no lane
// `tier` — its position comes from `computeSatelliteLayout`, not the lane stack.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type SatelliteNodeData = {
  kind: 'satellite'
  parentContextId: string
  // Navigate into the child canvas (re-scopes the core — the existing deep drill).
  onEnter: (parentContextId: string) => void
  // Unmount this satellite (collapse the child cluster).
  onCollapse: (parentContextId: string) => void
}
type SatelliteNode = Node<SatelliteNodeData, 'satellite'>

type CanvasNode =
  | DesignRegisterNode
  | DesignRingNode
  | FoundationHeaderNode
  | FoundationItemNode
  | ArchHeaderNode
  | ArchTableNode
  | SatelliteNode

// ── Cross-node focus helpers (P3.3). A table node's DOM is `.react-flow__node
// [data-id="<tableId>"]`; within it we land focus on the FIRST editable grid
// cell (forward entry) or the LAST editable position — the phantom "add entry"
// row (backward entry). Focusing an off-screen target trips the wrapper's
// `onFocusCapture` pan, bringing it on-screen (spike gate-d). `firstEditableCell`
// / `lastEditablePosition` now live in the shared `gridBoundaryFocus` seam module
// (084-D3 P0) so this consumer and the 084 Architecture chain adapter share one
// set of edge semantics. ─────────────────────────────────────────────────────

function nodeElement(nodeId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.react-flow__node[data-id="${nodeId}"]`)
}

// ── The derived-position projection. Reads each node's MEASURED height (or its
// seed estimate before measurement) and re-derives every node's {x,y} via
// computeLaneLayout. Returns the SAME array reference when nothing moved so it
// can be called from a measurement effect without churning. ──────────────────
function withDerivedPositions(nodes: CanvasNode[]): CanvasNode[] {
  // Lane nodes stack in tier columns (computeLaneLayout); satellite nodes hang in
  // a rightward column off the Design core (computeSatelliteLayout, P3). Both are
  // pure derived projections — no {x,y} is ever persisted.
  const laneItems: LaneItem[] = []
  const satelliteItems: SatelliteItem[] = []
  for (const n of nodes) {
    if (n.type === 'satellite') {
      satelliteItems.push({ id: n.id })
    } else {
      laneItems.push({
        id: n.id,
        tier: n.data.tier,
        sort: n.data.sort,
        height: n.measured?.height ?? n.data.estimate,
      })
    }
  }
  const posById = new Map<string, { x: number; y: number }>()
  for (const p of computeLaneLayout(laneItems, LANE_CONFIG)) posById.set(p.id, { x: p.x, y: p.y })
  // Satellites hang off the Design REGISTER's real right edge. 093 made the
  // register `width: max-content` (uncapped), so a nominal 960px would let a wide
  // register overlap the satellite + skew the edge (its source handle anchors to
  // the real box). Clear it with the register's MEASURED width (≥ the nominal).
  const registerWidth = nodes.find((n) => n.id === LANE_NODE_ID.design)?.measured?.width
  const clusterConfig: ClusterLayoutConfig = {
    ...CLUSTER_CONFIG,
    coreWidth: Math.max(CLUSTER_CONFIG.coreWidth, registerWidth ?? 0),
  }
  for (const p of computeSatelliteLayout(satelliteItems, LANE_NODE_ID.design, clusterConfig).positions) {
    posById.set(p.id, { x: p.x, y: p.y })
  }
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

// Design REGISTER node (P2): the top of the {register + ring} core — the rail +
// ContextRegister + lane header (the authoring surface). Carries the Design
// lane's stable node id so ⌘3 frames the column top. Body is `nodrag nopan
// nowheel` and records its lane active on focus/pointer (D2 `activeLane` gating).
function DesignRegisterNode({ data }: NodeProps<DesignRegisterNode>) {
  const setActiveLane = useActiveLaneStore((s) => s.setActiveLane)
  return (
    <div className="wc-node wc-node--design-register">
      {/* P3 — the parent end of a recursion edge to any open child satellite.
          Hidden + non-connectable (nodesConnectable stays false): a pure edge
          anchor, not a user-draggable connection point. */}
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="wc-edge-anchor"
      />
      <div className="wc-node__handle" aria-hidden="true">
        Design
      </div>
      <div
        className="nodrag nopan nowheel wc-node__body"
        onFocusCapture={() => setActiveLane('design')}
        onPointerDown={() => setActiveLane('design')}
      >
        <DesignRegisterBody
          projectId={data.projectId}
          contextPath={data.contextPath}
          view={data.view}
          canvasId={data.canvasId}
        />
      </div>
    </div>
  )
}

// Design RING node (P2): the derived visual glance (Canvas / CoverageMatrix),
// stacked BELOW the register. 085's rule holds — no on-ring authoring; the ring
// shares the compose draft with the register via the `canvasCompose` store.
function DesignRingNode({ data }: NodeProps<DesignRingNode>) {
  const setActiveLane = useActiveLaneStore((s) => s.setActiveLane)
  return (
    <div className="wc-node wc-node--design-ring">
      <div className="wc-node__handle" aria-hidden="true">
        Design · canvas
      </div>
      <div
        className="nodrag nopan nowheel wc-node__body"
        onFocusCapture={() => setActiveLane('design')}
        onPointerDown={() => setActiveLane('design')}
      >
        <DesignRingBody
          projectId={data.projectId}
          contextPath={data.contextPath}
          view={data.view}
          canvasId={data.canvasId}
        />
      </div>
    </div>
  )
}

// Foundation column header node: the heading + the Purpose / Existing-Scenario
// rich editors + the single add-prop phantom. Carries the Foundation lane's
// stable node id (LANE_NODE_ID.foundation) so ⌘1 frames the column top. Adding a
// value-prop continues focus into the new node (rAF×2, via onPropCreated).
function FoundationHeaderNode({ data }: NodeProps<FoundationHeaderNode>) {
  const setActiveLane = useActiveLaneStore((s) => s.setActiveLane)
  return (
    <div className="wc-node wc-node--foundation wc-node--foundation-header">
      <div className="wc-node__handle" aria-hidden="true">
        Foundation
      </div>
      <div
        className="nodrag nopan nowheel wc-node__body"
        onFocusCapture={() => setActiveLane('foundation')}
        onPointerDown={() => setActiveLane('foundation')}
      >
        <FoundationHeaderPanel readOnly={data.readOnly} onPropCreated={data.onPropCreated} />
      </div>
    </div>
  )
}

// Per-value-prop Foundation node: a header drag-handle bar (the degree + name)
// over the real name/description grid. `data-prop-id` makes the node addressable
// for the cross-node focus helpers; `onExitBoundary` wires the grid's Tab-off-a-
// -boundary seam to the canvas's next/prev-by-`sort` traversal.
function FoundationItemNode({ data }: NodeProps<FoundationItemNode>) {
  const setActiveLane = useActiveLaneStore((s) => s.setActiveLane)
  return (
    <div className="wc-node wc-node--foundation-item" data-prop-id={data.prop.id}>
      <div className="wc-node__handle" aria-hidden="true">
        <span className="wc-node__degree font-mono">{formatDegree(data.prop.rank)}</span>{' '}
        {data.prop.name}
      </div>
      <div
        className="nodrag nopan nowheel wc-node__body"
        onFocusCapture={() => setActiveLane('foundation')}
        onPointerDown={() => setActiveLane('foundation')}
      >
        <FoundationPropPanel
          prop={data.prop}
          readOnly={data.readOnly}
          onExitBoundary={(dir) => data.onExitBoundary(data.prop.id, dir)}
        />
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

// 089-D3 P3 — a recursion SATELLITE node: the summary card for a context's child
// canvas (issue 011), opened to the right of the Design core + edge-connected to
// it. It reads the parent context's symbol + child-context count straight from
// the contexts store (a separate React tree from the register that opened it), so
// the count stays live as the parent canvas mutates. `Enter ▸` navigates deep
// (the existing drill, which re-scopes the single core); `Collapse ×` unmounts
// it. NOT the base `.wc-node` class — the count-4 lane-node invariant must hold.
function SatelliteNode({ data }: NodeProps<SatelliteNode>) {
  const { parentContextId, onEnter, onCollapse } = data
  const contexts = useContextsStore((s) => s.contexts)
  const childCount = useContextsStore((s) => s.childCountByContext[parentContextId] ?? 0)
  const symbol = contexts.find((c) => c.id === parentContextId)?.symbol ?? '—'
  return (
    <div className="wc-satellite nodrag nopan" data-testid="wc-satellite">
      {/* The child end of the parent→child recursion edge. */}
      <Handle type="target" position={Position.Left} isConnectable={false} className="wc-edge-anchor" />
      <div className="wc-satellite__head">
        <span className="wc-satellite__symbol">{symbol} ▸</span>
        <Button
          variant="bare"
          className="wc-satellite__collapse"
          onClick={() => onCollapse(parentContextId)}
          aria-label={`Collapse child canvas of ${symbol}`}
        >
          ×
        </Button>
      </div>
      <div className="wc-satellite__body">
        <span className="wc-satellite__count">
          {childCount === 0 ? 'Empty child canvas' : `${childCount} context${childCount === 1 ? '' : 's'}`}
        </span>
        <Button variant="bare" className="wc-satellite__enter" onClick={() => onEnter(parentContextId)}>
          Enter ▸
        </Button>
      </div>
    </div>
  )
}

// Stable across renders — React Flow warns (and remounts nodes) if nodeTypes is
// a fresh object each render.
const NODE_TYPES = {
  designRegister: DesignRegisterNode,
  designRing: DesignRingNode,
  foundationHeader: FoundationHeaderNode,
  foundationItem: FoundationItemNode,
  archHeader: ArchHeaderNode,
  archTable: ArchTableNode,
  satellite: SatelliteNode,
}

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

  // P1 — the decomposed Foundation column is data-driven off the tier1 store the
  // same way: the flag-off app's `FoundationSurface` calls `load` itself, but it
  // never mounts here, so the canvas owns the load + drives one node per prop.
  const props = useTier1Store((s) => s.props)
  useEffect(() => {
    void useTier1Store.getState().load(projectId)
  }, [projectId])

  const { role } = useWorkspaceRole(projectId)
  const readOnly = !canWrite(role)

  const reactFlow = useReactFlow<CanvasNode>()

  // Latest tables/props in refs so the (stable) boundary callbacks read current
  // sort order without re-subscribing. Both are DB-ordered by `sort` ascending.
  const tablesRef = useRef(tables)
  tablesRef.current = tables
  const propsRef = useRef(props)
  propsRef.current = props

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

  // P1 — continue focus into a just-created value-prop's node (same rAF×2 mount
  // race as onTableCreated: store update → node build → RF mount → measure).
  const onPropCreated = useCallback((propId: string) => {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const node = nodeElement(propId)
        if (node) firstEditableCell(node)?.focus()
      }),
    )
  }, [])

  // P1 — cross-node Tab for Foundation, mirroring onTableExitBoundary: move focus
  // to the next-by-`sort` (forward) or prev-by-`sort` (backward) prop node.
  // Traversal follows the store's `sort` order, NOT DOM/array order.
  const onPropExitBoundary = useCallback((propId: string, dir: 'forward' | 'backward') => {
    const list = propsRef.current
    const idx = list.findIndex((p) => p.id === propId)
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

  // 089-D3 P3 — the open recursion satellites (issue 011). Opening a satellite is
  // pure canvas state (NO DB write): the register/ring drill affordances call
  // openSatellite; this canvas renders one summary node + a parent→child edge per
  // open child, and pans to the newly-focused one. The child canvas is only
  // materialized (openChildCanvas) when the user actually Enters it (lazy).
  const openSatellites = useCanvasSatellitesStore((s) => s.open)
  const satelliteFocus = useCanvasSatellitesStore((s) => s.focus)

  // The current context path in a ref so the (stable) satellite-Enter callback
  // navigates into [...currentPath, parentContextId] without re-subscribing.
  const contextPathRef = useRef(design.contextPath)
  contextPathRef.current = design.contextPath

  // Enter ▸ on a satellite: the existing deep drill — navigate into the child
  // canvas (re-scopes the single core; the canvas-nav reset clears satellites).
  const onSatelliteEnter = useCallback(
    (parentContextId: string) => {
      navigate({
        kind: 'design',
        projectId,
        contextPath: [...contextPathRef.current, parentContextId],
        view: 'canvas',
      })
    },
    [projectId],
  )
  const onSatelliteCollapse = useCallback((parentContextId: string) => {
    useCanvasSatellitesStore.getState().collapse(parentContextId)
  }, [])

  // Satellites are per-canvas: reset the open set whenever the active canvas
  // changes (deep-link / ⌘ / breadcrumb). The satellite nodes have stable ids and
  // never unmount, so this reset must be explicit (P2's hoveredMark lesson — a
  // stable id means there is no unmount to hang the reset on). Opening a satellite
  // does NOT change this identity (no navigate), so the set survives on-canvas.
  const canvasIdentity = `${projectId}::${design.contextPath.join('/')}::${design.canvasId ?? ''}`
  useEffect(() => {
    resetCanvasSatellites()
  }, [canvasIdentity])

  // The desired node set for the current tables + props + route + role. The
  // Foundation column is a header node (sort -1) + one `foundationItem` node per
  // value-prop (sort = prop.sort); the Architecture column is the header node
  // (sort -1) + one `archTable` node per table (sort = table.sort); Design stays
  // a whole-surface `lane` node (P2 decomposes it). Node
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
        type: 'foundationHeader',
        position: { x: 0, y: 0 },
        dragHandle: '.wc-node__handle',
        data: {
          tier: 'foundation',
          sort: -1,
          estimate: FOUNDATION_HEADER_ESTIMATE,
          readOnly,
          onPropCreated,
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
        // Register node keeps LANE_NODE_ID.design (sort 0, top) so ⌘3 frames it.
        id: LANE_NODE_ID.design,
        type: 'designRegister',
        position: { x: 0, y: 0 },
        dragHandle: '.wc-node__handle',
        data: {
          tier: 'design',
          sort: 0,
          estimate: DESIGN_REGISTER_ESTIMATE,
          projectId,
          contextPath: design.contextPath,
          view: design.view,
          canvasId: design.canvasId,
        },
      },
      {
        // Ring node (sort 1, below) — stacked under the register per the owner's
        // "register OVER ring" layout; computeLaneLayout stacks them by `sort`.
        id: DESIGN_RING_NODE_ID,
        type: 'designRing',
        position: { x: 0, y: 0 },
        dragHandle: '.wc-node__handle',
        data: {
          tier: 'design',
          sort: 1,
          estimate: DESIGN_RING_ESTIMATE,
          projectId,
          contextPath: design.contextPath,
          view: design.view,
          canvasId: design.canvasId,
        },
      },
    ]
    // Emitted in DESCENDING sort (like the arch tables) so DOM/array order ≠
    // visual/stack order — hardening the cross-node-Tab-follows-`sort` invariant.
    for (const prop of [...props].reverse()) {
      list.push({
        id: prop.id,
        type: 'foundationItem',
        position: { x: 0, y: 0 },
        dragHandle: '.wc-node__handle',
        data: {
          tier: 'foundation',
          sort: prop.sort,
          estimate: FOUNDATION_ITEM_ESTIMATE,
          prop,
          readOnly,
          onExitBoundary: onPropExitBoundary,
        },
      })
    }
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
    // P3 — one satellite summary node per open child canvas, in open order (the
    // clusterLayout stack order). Position is derived; not draggable (no reorder).
    for (const parentContextId of openSatellites) {
      list.push({
        id: satelliteNodeId(parentContextId),
        type: 'satellite',
        position: { x: 0, y: 0 },
        draggable: false,
        data: {
          kind: 'satellite',
          parentContextId,
          onEnter: onSatelliteEnter,
          onCollapse: onSatelliteCollapse,
        },
      })
    }
    return list
  }, [
    tables,
    props,
    projectId,
    design.contextPath,
    design.view,
    design.canvasId,
    readOnly,
    onTableCreated,
    onTableExitBoundary,
    onPropCreated,
    onPropExitBoundary,
    openSatellites,
    onSatelliteEnter,
    onSatelliteCollapse,
  ])

  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(desiredNodes)

  // P3 — the recursion edges (the app's FIRST React Flow edges): one parent→child
  // edge per open satellite. Derived from the RECONCILED satellite NODES (not the
  // store's open set) so an edge never targets a node React Flow doesn't yet have
  // in `nodes` — the reconcile effect adds a satellite node one commit after the
  // store opens it, so sourcing edges off `nodes` keeps them in lockstep. Fully
  // derived + never user-edited (nodesConnectable stays false), so there is no
  // useEdgesState; a stable join-key memo keeps the edges array identity constant
  // across measure-only node updates, and computeSatelliteLayout's stable edge ids
  // keep RF's edge reconcile from churning (the loop-avoidance discipline).
  const satelliteNodeIds = nodes.flatMap((n) => (n.type === 'satellite' ? [n.id] : []))
  const satelliteEdgeKey = satelliteNodeIds.join('|')
  const edges = useMemo<Edge[]>(
    () =>
      computeSatelliteLayout(
        satelliteNodeIds.map((id) => ({ id })),
        LANE_NODE_ID.design,
        CLUSTER_CONFIG,
      ).edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        className: 'wc-edge',
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    // satelliteNodeIds is derived from satelliteEdgeKey; keying on the string keeps
    // the edges array stable across measure-only `nodes` updates (join-key memo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [satelliteEdgeKey],
  )

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
  // Track WIDTH as well as height: a satellite's x is derived from the register's
  // measured width (093 uncapped it), and adding a dimension widens the register
  // WITHOUT necessarily changing its height — a height-only signature would leave
  // the satellite overlapping. Width feeds only the satellite clearance, never the
  // lane x-stride, so the derived-positions invariant holds.
  const measuredSignature = nodes
    .map((n) => `${n.id}:${Math.round(n.measured?.height ?? 0)}x${Math.round(n.measured?.width ?? 0)}`)
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

  // P3 — pan/zoom to a freshly-opened (or re-focused) satellite. `focus` is a
  // one-shot set by openSatellite; we wait for the node to mount + measure (this
  // effect re-runs as `nodes` updates), fit it into view, then consumeFocus so a
  // later reconcile never yanks the viewport back. Reduced-motion snaps.
  useEffect(() => {
    if (!satelliteFocus) return
    const node = reactFlow.getNode(satelliteFocus)
    if (node?.measured?.height == null) return
    void reactFlow.fitView({
      nodes: [{ id: satelliteFocus }],
      padding: 0.3,
      maxZoom: 1,
      duration: prefersReducedMotion() ? 0 : FOCUS_PAN_DURATION,
    })
    useCanvasSatellitesStore.getState().consumeFocus()
    // `nodes` is a re-run trigger only (the node must exist + be measured first).
  }, [satelliteFocus, nodes, reactFlow])

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
      const columnX =
        node.type === 'archTable'
          ? ARCH_COLUMN_X
          : node.type === 'foundationItem'
            ? FOUNDATION_COLUMN_X
            : null
      if (columnX === null) return
      setNodes((prev) =>
        prev.map((n) =>
          n.id === node.id && n.position.x !== columnX
            ? { ...n, position: { x: columnX, y: node.position.y } }
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
      // Rank the dragged node's SIBLINGS (same node type) by center-y — the
      // dragged node using its live dropped y, siblings their derived y — and the
      // dragged node's rank is the index it now occupies. Persist via the store's
      // reorder (which rewrites ONLY `sort`/`rank`, never a `{x,y}`).
      const reorderType =
        node.type === 'archTable' || node.type === 'foundationItem' ? node.type : null
      if (reorderType !== null) {
        const siblings = reactFlow.getNodes().filter((n) => n.type === reorderType)
        const ranked = siblings
          .map((n) => {
            const y = n.id === node.id ? node.position.y : n.position.y
            // siblings are all `reorderType` (archTable/foundationItem), which
            // carry `estimate`; the `in` guard narrows the CanvasNode union (a
            // satellite, which has no estimate, can never be a reorder sibling).
            const height = n.measured?.height ?? ('estimate' in n.data ? n.data.estimate : SATELLITE_ESTIMATE)
            return { id: n.id, center: y + height / 2 }
          })
          .sort((a, b) => a.center - b.center)
        const targetIndex = ranked.findIndex((r) => r.id === node.id)
        if (targetIndex !== -1) {
          if (reorderType === 'archTable') {
            void useTier2Store.getState().reorderTable(node.id, targetIndex)
          } else {
            void useTier1Store.getState().reorderProp(node.id, targetIndex)
          }
        }
      }
      setNodes((prev) => withDerivedPositions(prev))
    },
    [reactFlow, setNodes],
  )

  return (
    <div className="workspace-canvas" ref={wrapperRef} onFocusCapture={onFocusCapture}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
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
