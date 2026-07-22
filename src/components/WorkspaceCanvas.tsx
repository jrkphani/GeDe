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
  useStore,
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
} from '../domain/clusterLayout'
import {
  resetCanvasSatellites,
  satelliteNodeId,
  useCanvasSatellitesStore,
} from '../store/canvasSatellites'
import { useCanvasCoverageStore } from '../store/canvasCoverage'
import { releaseCanvasStores } from '../store/canvasStores'
import { useActiveCanvasStore } from '../store/activeCanvas'
import { useActiveLaneStore } from '../store/activeLane'
import { canWrite } from '../domain/workspaceRole'
import { formatDegree } from '../domain/degree'
import { useTier1Store } from '../store/tier1'
import { useTier2Store } from '../store/tier2'
import { useWorkspaceRole } from '../store/workspace'
import type { Tier1PropRow, Tier2TableRow } from '../db/mutations'
import type { AppRoute, DesignView } from '../shell/routes'
import { DesignCoverageTwinBody, DesignRegisterBody, DesignRingBody } from './DesignCoreAdapter'
import { firstEditableCell, lastEditablePosition } from './gridBoundaryFocus'
import { focusPanTarget } from './workspaceFocusPan'
import { FoundationHeaderPanel, FoundationPropPanel } from './FoundationCanvasNodes'
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
// Issue 100 Phase D — a drilled-in LIVE CHILD core reuses the register/ring node
// types but NAMESPACES their ids off the parent context id, so the PRIMARY ids
// (LANE_NODE_ID.design / DESIGN_RING_NODE_ID — the ⌘3 pan, coverage-twin edge,
// and gap-compose pan targets) stay singletons pointing at the root core. Child
// cores are purely additive.
const childRegisterNodeId = (parentContextId: string): string => `${LANE_NODE_ID.design}:${parentContextId}`
const childRingNodeId = (parentContextId: string): string => `${DESIGN_RING_NODE_ID}:${parentContextId}`
// P4 (issue 012) — the coverage TWIN node, stacked in the Design lane BELOW the
// ring (sort 2) and edge-connected to it. One per canvas (a singleton).
const COVERAGE_TWIN_NODE_ID = 'workspace-canvas-coverage-twin'
const COVERAGE_TWIN_ESTIMATE = 520
const ARCH_HEADER_ESTIMATE = 160
const ARCH_TABLE_ESTIMATE = 340

// 089-P5 — LOD threshold for the per-item lane nodes (Foundation props, Arch
// tables): below this viewport zoom their heavy real grid is swapped for a
// lightweight summary card (overview legibility + fewer mounted grids at volume).
// A body-local BOOLEAN `useStore` selector (like 093's register `LOD_ZOOM`) →
// re-renders a body only when the threshold is CROSSED, never per pan/zoom frame,
// and never through the WorkspaceCanvas reconcile/measuredSignature hot path.
// Deliberately LOWER than the register's 0.6: a small project fit-views at ~0.5,
// where the grammar e2e specs interact with the real grid — so lane items must
// stay expanded there and only summarize when zoomed out FURTHER (a volume
// project fit-views far below this, so its overview shows summary cards).
const LANE_LOD_ZOOM = 0.35

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
  // Issue 100 Phase D — WHICH store instance this core resolves (SEPARATE from
  // canvasId). Undefined on the PRIMARY core → the default instance; set to the
  // parent context id on a live CHILD core → its own independent instance. Also
  // the discriminator `withDerivedPositions` uses to hang a child core in the
  // satellite column rather than the primary Design lane stack.
  storeCanvasId?: string | null | undefined
  // Issue 100 Phase D — collapse a live child core (undefined on the primary).
  onCollapse?: (() => void) | undefined
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

// Issue 100 Phase D — the P3 summary SATELLITE stub is GONE: drilling now mounts
// a second LIVE {register + ring} core (namespaced `designRegister`/`designRing`
// nodes, storeCanvasId = the parent context id) in the rightward column the stub
// used to occupy. The contexts store is no longer a singleton (Phase A/B factory
// + registry), so a child core holds its own instance and edits in place.

// P4 (issue 012) — the coverage TWIN node: a design-lane node (tier 'design',
// sort 2) so computeLaneLayout stacks it below the ring, edge-connected to it. It
// renders the read-only CoverageMatrix from the current-canvas stores (a FULLY
// LIVE node, not a P3-style stub — no second canvas scope).
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type CoverageTwinNodeData = {
  tier: 'design'
  sort: number
  estimate: number
  projectId: string
  // Issue 100 Phase C — the active-canvas key of the core this twin belongs to
  // (same as its register/ring siblings), so focusing the twin records the SAME
  // core active. Undefined for the root core → 'root'.
  canvasId: string | undefined
  // Pan back along the edge to the ring after a gap-cell compose (so the new
  // draft dot is in view).
  onGapComposed: () => void
}
type CoverageTwinNode = Node<CoverageTwinNodeData, 'coverageTwin'>

type CanvasNode =
  | DesignRegisterNode
  | DesignRingNode
  | FoundationHeaderNode
  | FoundationItemNode
  | ArchHeaderNode
  | ArchTableNode
  | CoverageTwinNode

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
// Issue 100 Phase D — a design-tier node belongs to a live CHILD core (not the
// primary) exactly when it carries a storeCanvasId. Child cores hang in the
// satellite column; the primary register/ring/twin stack in the Design lane.
function childCoreParentId(node: CanvasNode): string | null {
  if (node.type !== 'designRegister' && node.type !== 'designRing') return null
  return node.data.storeCanvasId ?? null
}

function withDerivedPositions(nodes: CanvasNode[]): CanvasNode[] {
  // Lane nodes stack in tier columns (computeLaneLayout). A drilled-in live CHILD
  // core (Phase D) hangs in a rightward column off the Design core — where the P3
  // summary stub used to sit — its REGISTER taking the satellite slot and its RING
  // stacked directly below its own register. Both are pure derived projections —
  // no {x,y} is ever persisted.
  const laneItems: LaneItem[] = []
  const childRegisters: CanvasNode[] = []
  const childRingByParent = new Map<string, CanvasNode>()
  for (const n of nodes) {
    const childParent = childCoreParentId(n)
    if (childParent !== null) {
      if (n.type === 'designRegister') childRegisters.push(n)
      else childRingByParent.set(childParent, n)
      continue
    }
    laneItems.push({
      id: n.id,
      tier: n.data.tier,
      sort: n.data.sort,
      height: n.measured?.height ?? n.data.estimate,
    })
  }
  const posById = new Map<string, { x: number; y: number }>()
  for (const p of computeLaneLayout(laneItems, LANE_CONFIG)) posById.set(p.id, { x: p.x, y: p.y })
  // Child cores hang off the PRIMARY Design core's real right edge. 093 made the
  // register `width: max-content` (uncapped) and P4 added a coverage twin that can
  // be even wider — all three primary design nodes share the column, so children
  // must clear the WIDEST measured PRIMARY design-column node (a child core's own
  // width never feeds the clearance). Width feeds clearance only, never the lane
  // x-stride.
  let coreWidth = CLUSTER_CONFIG.coreWidth
  for (const n of nodes) {
    if (childCoreParentId(n) === null && n.data.tier === 'design' && n.measured?.width) {
      coreWidth = Math.max(coreWidth, n.measured.width)
    }
  }
  const clusterConfig: ClusterLayoutConfig = { ...CLUSTER_CONFIG, coreWidth }
  // computeSatelliteLayout gives the shared column x (and, for a single child, the
  // stub's original y=0 slot). A live core is far taller than the fixed stub
  // height, so stack each child's register+ring by their MEASURED heights to avoid
  // overlap when several children are open, seeded at that x/first-slot baseline.
  const slots = computeSatelliteLayout(
    childRegisters.map((n) => ({ id: n.id })),
    LANE_NODE_ID.design,
    clusterConfig,
  ).positions
  const childColumnX = slots[0]?.x ?? clusterConfig.originX + coreWidth + clusterConfig.coreGap
  let childY = 0
  for (const reg of childRegisters) {
    posById.set(reg.id, { x: childColumnX, y: childY })
    const regHeight = reg.measured?.height ?? reg.data.estimate
    const ringY = childY + regHeight + LANE_CONFIG.nodeGap
    const ring = childRingByParent.get(childCoreParentId(reg) as string)
    if (ring) {
      posById.set(ring.id, { x: childColumnX, y: ringY })
      childY = ringY + (ring.measured?.height ?? ring.data.estimate) + LANE_CONFIG.nodeGap
    } else {
      childY = ringY
    }
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
      {/* The parent end of a recursion edge to any open live child core (P3's
          satellite is now a live core, Phase D). Hidden + non-connectable
          (nodesConnectable stays false): a pure edge anchor. */}
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        className="wc-edge-anchor"
      />
      {/* Issue 100 Phase D — the CHILD end of the parent→child edge. Harmless on
          the primary register (no edge targets it): a hidden, non-connectable
          anchor. */}
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        className="wc-edge-anchor"
      />
      <div className="wc-node__handle" aria-hidden="true">
        Design
      </div>
      <div
        className="nodrag nopan nowheel wc-node__body"
        onFocusCapture={() => {
          setActiveLane('design')
          useActiveCanvasStore.getState().setActiveCanvas(data.canvasId ?? 'root')
        }}
        onPointerDown={() => {
          setActiveLane('design')
          useActiveCanvasStore.getState().setActiveCanvas(data.canvasId ?? 'root')
        }}
      >
        <DesignRegisterBody
          projectId={data.projectId}
          contextPath={data.contextPath}
          view={data.view}
          canvasId={data.canvasId}
          storeCanvasId={data.storeCanvasId}
          onCollapse={data.onCollapse}
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
      {/* P4 — the parent end of the edge down to the coverage twin (hidden,
          non-connectable: a pure edge anchor). */}
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className="wc-edge-anchor"
      />
      <div className="wc-node__handle" aria-hidden="true">
        Design · canvas
      </div>
      <div
        className="nodrag nopan nowheel wc-node__body"
        onFocusCapture={() => {
          setActiveLane('design')
          useActiveCanvasStore.getState().setActiveCanvas(data.canvasId ?? 'root')
        }}
        onPointerDown={() => {
          setActiveLane('design')
          useActiveCanvasStore.getState().setActiveCanvas(data.canvasId ?? 'root')
        }}
      >
        <DesignRingBody
          projectId={data.projectId}
          contextPath={data.contextPath}
          view={data.view}
          canvasId={data.canvasId}
          storeCanvasId={data.storeCanvasId}
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
// P5 LOD for a per-item lane node — collapse to a summary card when zoomed out,
// but NEVER while the node is being edited. An EditableGrid text/richtext cell
// commits on BLUR, so collapsing (unmounting the grid) mid-edit could drop the
// pending keystrokes (adversarial-review HIGH); a body-local focus-within flag
// keeps an actively-edited node expanded until focus leaves it. The `collapsed`
// boolean is a pure fn of RF zoom + focus — never node height — so it stays out
// of the reconcile/measuredSignature hot path (093's boolean-selector discipline).
function useLaneLod(): {
  collapsed: boolean
  onFocusCapture: () => void
  onBlurCapture: (e: FocusEvent<HTMLElement>) => void
} {
  const zoomedOut = useStore((s) => s.transform[2] < LANE_LOD_ZOOM)
  // Focus is tracked in a REF, not state: setting state on focus would re-render
  // the node body mid-click and cancel EditableGrid's click-to-edit (an observed
  // regression). The ref is read when the node re-renders — which the `useStore`
  // zoom selector already does exactly on a threshold crossing — so an
  // actively-edited node (focus ref true) that the user WHEEL-zooms out stays
  // expanded (its grid never unmounts → no dropped keystrokes), while a normal
  // cell click never triggers a spurious re-render. A blurred node re-collapses on
  // the next zoom/pan re-render (a cosmetic lag, not a correctness issue).
  const focusedRef = useRef(false)
  return {
    collapsed: zoomedOut && !focusedRef.current,
    onFocusCapture: () => {
      focusedRef.current = true
    },
    onBlurCapture: (e) => {
      // Clear only when focus truly leaves the node body (not on an intra-node
      // focus move). relatedTarget null (focus to nothing) also clears — correct.
      if (!e.currentTarget.contains(e.relatedTarget)) focusedRef.current = false
    },
  }
}

function FoundationItemNode({ data }: NodeProps<FoundationItemNode>) {
  const setActiveLane = useActiveLaneStore((s) => s.setActiveLane)
  const lod = useLaneLod()
  return (
    <div className="wc-node wc-node--foundation-item" data-prop-id={data.prop.id}>
      <div className="wc-node__handle" aria-hidden="true">
        <span className="wc-node__degree font-mono">{formatDegree(data.prop.rank)}</span>{' '}
        {data.prop.name}
      </div>
      <div
        className="nodrag nopan nowheel wc-node__body"
        onFocusCapture={() => {
          setActiveLane('foundation')
          lod.onFocusCapture()
        }}
        onBlurCapture={lod.onBlurCapture}
        onPointerDown={() => setActiveLane('foundation')}
      >
        {lod.collapsed ? (
          <div className="wc-lane-summary" data-testid="wc-lane-summary">
            <span className="wc-lane-summary__name">{data.prop.name}</span>
            <span className="wc-lane-summary__meta">value proposition</span>
          </div>
        ) : (
          <FoundationPropPanel
            prop={data.prop}
            readOnly={data.readOnly}
            onExitBoundary={(dir) => data.onExitBoundary(data.prop.id, dir)}
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
  const lod = useLaneLod()
  return (
    <div className="wc-node wc-node--arch-table" data-table-id={data.table.id}>
      <div className="wc-node__handle" aria-hidden="true">
        {data.table.name}
      </div>
      <div
        className="nodrag nopan nowheel wc-node__body"
        onFocusCapture={() => {
          setActiveLane('architecture')
          lod.onFocusCapture()
        }}
        onBlurCapture={lod.onBlurCapture}
        onPointerDown={() => setActiveLane('architecture')}
      >
        {lod.collapsed ? (
          <div className="wc-lane-summary" data-testid="wc-lane-summary">
            <span className="wc-lane-summary__name">{data.table.name}</span>
            <span className="wc-lane-summary__meta">table</span>
          </div>
        ) : (
          <TablePanel
            projectId={data.projectId}
            table={data.table}
            readOnly={data.readOnly}
            onExitBoundary={(dir) => data.onExitBoundary(data.table.id, dir)}
          />
        )}
      </div>
    </div>
  )
}

// P4 (issue 012) — the coverage TWIN node: the analytical twin of the ring,
// stacked below the Design core + edge-connected to it. Its body (DesignCoverageTwinBody)
// renders the read-only CoverageMatrix from the current-canvas stores; a gap-cell
// click composes pre-filled then pans back to the ring. Body is `nodrag nopan
// nowheel` (the matrix scrolls/clicks internally) and records the Design lane
// active on focus/pointer (D2 activeLane gating), like the other design bodies.
function CoverageTwinNode({ data }: NodeProps<CoverageTwinNode>) {
  const setActiveLane = useActiveLaneStore((s) => s.setActiveLane)
  return (
    <div className="wc-node wc-node--coverage-twin" data-testid="wc-coverage-twin">
      {/* The child end of the ring→twin edge. */}
      <Handle type="target" position={Position.Top} isConnectable={false} className="wc-edge-anchor" />
      <div className="wc-node__handle" aria-hidden="true">
        Design · coverage
      </div>
      <div
        className="nodrag nopan nowheel wc-node__body"
        onFocusCapture={() => {
          setActiveLane('design')
          useActiveCanvasStore.getState().setActiveCanvas(data.canvasId ?? 'root')
        }}
        onPointerDown={() => {
          setActiveLane('design')
          useActiveCanvasStore.getState().setActiveCanvas(data.canvasId ?? 'root')
        }}
      >
        <DesignCoverageTwinBody projectId={data.projectId} onGapComposed={data.onGapComposed} />
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
  coverageTwin: CoverageTwinNode,
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

  // Issue 100 Phase D — the open drilled-in child cores (issue 011 recursion).
  // Opening is pure canvas state (NO DB write): the register/ring drill
  // affordances call openSatellite; this canvas mounts a LIVE {register + ring}
  // child core (its own store instance, keyed by the parent context id) + a
  // parent→child edge per open child, and pans to the newly-focused one. The
  // child canvas is materialized (openChildCanvas) by the child register's own
  // load effect once it mounts.
  const openSatellites = useCanvasSatellitesStore((s) => s.open)
  const satelliteFocus = useCanvasSatellitesStore((s) => s.focus)

  // Collapse a live child core: drop it from the open set AND release its store
  // instance (per-instance DB-sync teardown — the whole point of the independent
  // instance). Collapse is an explicit user action, so a mid-edit unmount is
  // user-chosen (deferred: zoom-LOD auto-culling of off-screen child cores).
  const onSatelliteCollapse = useCallback((parentContextId: string) => {
    useCanvasSatellitesStore.getState().collapse(parentContextId)
    releaseCanvasStores(parentContextId)
  }, [])

  // Child cores are per-canvas: reset the open set whenever the active canvas
  // changes (deep-link / ⌘ / breadcrumb), releasing every child store the
  // previous canvas held (else its DB-sync subscription leaks — the reset only
  // clears the id list). Read via a ref so this effect keys only on canvasIdentity
  // (at reset time the store still holds the OLD canvas's open set — the reset
  // below is what clears it). Opening a child core does NOT change this identity
  // (no navigate), so the set survives on-canvas.
  const openSatellitesRef = useRef(openSatellites)
  openSatellitesRef.current = openSatellites
  const canvasIdentity = `${projectId}::${design.contextPath.join('/')}::${design.canvasId ?? ''}`
  useEffect(() => {
    for (const parentContextId of openSatellitesRef.current) releaseCanvasStores(parentContextId)
    resetCanvasSatellites()
  }, [canvasIdentity])

  // P4 (issue 012) — the coverage twin's open state + its one-shot pan target.
  const coverageOpen = useCanvasCoverageStore((s) => s.open)
  const coverageFocus = useCanvasCoverageStore((s) => s.focus)

  // Seed the twin from the route's `view` on canvas-nav: a `?view=coverage`
  // deep-link opens the twin (grammar preserved), a normal canvas-nav closes it
  // (doubles as the per-canvas reset — the twin node has a stable id and never
  // unmounts). `v`/the header toggle change the store WITHOUT touching the route,
  // so neither dep here fires and the toggle persists on-canvas.
  useEffect(() => {
    useCanvasCoverageStore.getState().setOpen(design.view === 'coverage')
  }, [canvasIdentity, design.view])

  // Pan back along the edge to the ring after a coverage gap-cell compose, so the
  // freshly-composed draft dot is in view (the twin + ring coexist).
  const onGapComposed = useCallback(() => {
    void reactFlow.fitView({
      nodes: [{ id: DESIGN_RING_NODE_ID }],
      padding: 0.3,
      maxZoom: 1,
      duration: prefersReducedMotion() ? 0 : FOCUS_PAN_DURATION,
    })
  }, [reactFlow])

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
          // P4 — the core bodies always render as 'canvas'; coverage is the twin
          // node now, seeded from route.view (a `?view=coverage` deep-link opens
          // the twin, not the old ring swap). routes.ts grammar preserved.
          view: 'canvas',
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
          view: 'canvas',
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
    // Issue 100 Phase D — one LIVE {register + ring} child core per open child
    // canvas, in open order (the clusterLayout stack order). NAMESPACED ids +
    // storeCanvasId = parentContextId give each child its own independent store
    // instance; contextPath grows by the parent context id so its load effect
    // materializes + loads the child canvas. Positions are derived (satellite
    // column); not draggable (no reorder). The primary core's nodes/ids/data
    // above are UNTOUCHED (storeCanvasId omitted → default instance).
    for (const parentContextId of openSatellites) {
      const childContextPath = [...design.contextPath, parentContextId]
      list.push({
        id: childRegisterNodeId(parentContextId),
        type: 'designRegister',
        position: { x: 0, y: 0 },
        draggable: false,
        data: {
          tier: 'design',
          sort: 0,
          estimate: DESIGN_REGISTER_ESTIMATE,
          projectId,
          contextPath: childContextPath,
          view: 'canvas',
          canvasId: parentContextId,
          storeCanvasId: parentContextId,
          onCollapse: () => onSatelliteCollapse(parentContextId),
        },
      })
      list.push({
        id: childRingNodeId(parentContextId),
        type: 'designRing',
        position: { x: 0, y: 0 },
        draggable: false,
        data: {
          tier: 'design',
          sort: 1,
          estimate: DESIGN_RING_ESTIMATE,
          projectId,
          contextPath: childContextPath,
          view: 'canvas',
          canvasId: parentContextId,
          storeCanvasId: parentContextId,
        },
      })
    }
    // P4 — the coverage twin, when open: a design-lane node (sort 2) so
    // computeLaneLayout stacks it below the ring; edge-connected to the ring.
    if (coverageOpen) {
      list.push({
        id: COVERAGE_TWIN_NODE_ID,
        type: 'coverageTwin',
        position: { x: 0, y: 0 },
        draggable: false,
        data: {
          tier: 'design',
          sort: 2,
          estimate: COVERAGE_TWIN_ESTIMATE,
          projectId,
          canvasId: design.canvasId,
          onGapComposed,
        },
      })
    }
    return list
  }, [
    tables,
    props,
    projectId,
    design.contextPath,
    design.canvasId,
    readOnly,
    onTableCreated,
    onTableExitBoundary,
    onPropCreated,
    onPropExitBoundary,
    openSatellites,
    onSatelliteCollapse,
    coverageOpen,
    onGapComposed,
  ])

  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(desiredNodes)

  // The recursion edges: one PRIMARY→child edge per open live child core. Derived
  // from the RECONCILED child-register NODES (not the store's open set) so an edge
  // never targets a node React Flow doesn't yet have in `nodes` — the reconcile
  // effect adds a child core one commit after the store opens it, so sourcing
  // edges off `nodes` keeps them in lockstep. Fully derived + never user-edited
  // (nodesConnectable stays false), so there is no useEdgesState; a stable
  // join-key memo keeps the edges array identity constant across measure-only node
  // updates, and stable edge ids keep RF's edge reconcile from churning. Every
  // edge sources from LANE_NODE_ID.design (the PRIMARY register) — a nested child
  // core's own edge origin is a deferred follow-up.
  const childRegisterIds = nodes.flatMap((n) =>
    n.type === 'designRegister' && n.data.storeCanvasId != null ? [n.id] : [],
  )
  const hasCoverageTwin = nodes.some((n) => n.type === 'coverageTwin')
  // Key on the child-core set + the twin presence so the edges array identity only
  // changes when the edge SET changes, not on measure-only `nodes` updates.
  const edgeKey = `${childRegisterIds.join('|')}#${hasCoverageTwin ? '1' : '0'}`
  const edges = useMemo<Edge[]>(() => {
    const childEdges: Edge[] = childRegisterIds.map((id) => ({
      id: `edge:${LANE_NODE_ID.design}:${id}`,
      source: LANE_NODE_ID.design,
      target: id,
      className: 'wc-edge',
      markerEnd: { type: MarkerType.ArrowClosed },
    }))
    // P4 — the ring→twin edge (only when the twin is mounted, so it never targets
    // a node RF doesn't have).
    const twinEdges: Edge[] = hasCoverageTwin
      ? [
          {
            id: `edge:${DESIGN_RING_NODE_ID}:${COVERAGE_TWIN_NODE_ID}`,
            source: DESIGN_RING_NODE_ID,
            target: COVERAGE_TWIN_NODE_ID,
            className: 'wc-edge',
            markerEnd: { type: MarkerType.ArrowClosed },
          },
        ]
      : []
    return [...childEdges, ...twinEdges]
    // childRegisterIds/hasCoverageTwin are derived from edgeKey; keying on the
    // string keeps the edges array stable across measure-only `nodes` updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edgeKey])

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

  // Pan/zoom to a freshly-opened (or re-focused) live child core. `focus` is the
  // one-shot `satelliteNodeId(parentContextId)` token set by openSatellite; we map
  // it back to the parent context id (the open set holds the raw ids) → the child
  // REGISTER node id, wait for that node to mount + measure (this effect re-runs as
  // `nodes` updates), fit it into view, then consumeFocus so a later reconcile
  // never yanks the viewport back. Reduced-motion snaps.
  useEffect(() => {
    if (!satelliteFocus) return
    const parentContextId = openSatellites.find((id) => satelliteNodeId(id) === satelliteFocus)
    if (!parentContextId) return
    const targetId = childRegisterNodeId(parentContextId)
    const node = reactFlow.getNode(targetId)
    if (node?.measured?.height == null) return
    void reactFlow.fitView({
      nodes: [{ id: targetId }],
      padding: 0.3,
      maxZoom: 1,
      duration: prefersReducedMotion() ? 0 : FOCUS_PAN_DURATION,
    })
    useCanvasSatellitesStore.getState().consumeFocus()
    // `nodes` is a re-run trigger only (the node must exist + be measured first).
  }, [satelliteFocus, openSatellites, nodes, reactFlow])

  // P4 — pan/zoom to the coverage twin when it opens (same one-shot pattern as the
  // satellite pan: wait for mount + measure, fit, then consumeFocus).
  useEffect(() => {
    if (!coverageFocus) return
    const node = reactFlow.getNode(COVERAGE_TWIN_NODE_ID)
    if (node?.measured?.height == null) return
    void reactFlow.fitView({
      nodes: [{ id: COVERAGE_TWIN_NODE_ID }],
      padding: 0.3,
      maxZoom: 1,
      duration: prefersReducedMotion() ? 0 : FOCUS_PAN_DURATION,
    })
    useCanvasCoverageStore.getState().consumeFocus()
  }, [coverageFocus, nodes, reactFlow])

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

  // Focus-driven pan is KEYBOARD-ONLY (issue 101): native `scrollIntoView` is a
  // no-op on a transformed plane, so a keyboard-navigated focus (Tab / cross-node
  // Tab / a create's programmatic focus) that lands on an off-screen cell needs an
  // explicit pan to bring it into view. But a MOUSE/TOUCH click focuses something
  // the user can already see (you can't click what isn't rendered), so panning
  // there is pointless + jarring. We track the last input modality with a
  // persistent ref (NOT a timer — a rAF-cleared flag misclassifies touch, whose
  // tap→focus can span >1 frame, and races the codebase's own rAF-deferred
  // `.focus()` calls). `onPointerDownCapture` flips it to pointer; `onKeyDownCapture`
  // flips it to keyboard; both are passive capture-phase listeners on the wrapper.
  const lastInputWasKeyboardRef = useRef(false)

  // Focus-driven pan (D3 spike gate-d): pan-if-outside-margin, never
  // center-on-every-focus — only when the focused element is near/past a pane
  // edge do we `setCenter` on it, keeping the CURRENT zoom. Reduced-motion snaps.
  const onFocusCapture = useCallback(
    (e: FocusEvent<HTMLDivElement>) => {
      // Pointer-initiated focus (a click) never pans — the target is already
      // visible; only keyboard-driven focus can target an off-screen cell.
      if (!lastInputWasKeyboardRef.current) return
      const target = e.target as HTMLElement | null
      const pane = wrapperRef.current
      if (!target || !pane || typeof target.getBoundingClientRect !== 'function') return
      // Pure pan-decision (unit-tested in workspaceFocusPan.test.ts) — returns
      // the screen point to centre on, or null when the element is already in
      // view. The flaky setCenter-vs-fitView race is React Flow's, not ours.
      const point = focusPanTarget(target.getBoundingClientRect(), pane.getBoundingClientRect(), FOCUS_PAN_MARGIN)
      if (!point) return
      const center = reactFlow.screenToFlowPosition(point)
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
    // 089-P7: the canvas is now the DEFAULT primary content region, so it carries
    // the `main` landmark (role, not <main>, to keep the HTMLDivElement ref +
    // FocusEvent typing) that the tier surfaces provide on the fallback path.
    <div
      className="workspace-canvas"
      ref={wrapperRef}
      onFocusCapture={onFocusCapture}
      // Track input modality so the focus-pan fires ONLY for keyboard nav, never
      // on a click (issue 101). Passive capture-phase listeners — no preventDefault,
      // so React Flow's own pane-pan / node-drag pointer handling is untouched.
      onPointerDownCapture={() => {
        lastInputWasKeyboardRef.current = false
      }}
      onKeyDownCapture={() => {
        lastInputWasKeyboardRef.current = true
      }}
      role="main"
      aria-label="Workspace canvas"
    >
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
        // NOTE (089-P5): `onlyRenderVisibleElements` was evaluated + REMOVED — it
        // unmounts off-screen nodes, which breaks specs (and UX) that zoom into a
        // node and read its content without first ensuring it is in view, and the
        // real volume bottleneck is the register's own cell count (handled by the
        // 093 zoom-collapse + the P5 >8-column collapse), not the lane-node count.
        // Overview load is reduced instead by the LOD summary cards below.
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
