import { useMemo } from 'react'
import {
  Background,
  Controls,
  ReactFlow,
  useNodesState,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { computeLaneLayout, LANE_ORDER, type LaneLayoutConfig, type LaneTier } from '../domain/laneLayout'
import { useActiveLaneStore } from '../store/activeLane'
import type { AppRoute, DesignView } from '../shell/routes'
import { ArchitectureSurface } from './ArchitectureSurface'
import { DesignSurface } from './DesignSurface'
import { FoundationSurface } from './FoundationSurface'

// 089-D3 P2 — three lanes on one canvas. P1 mounted ONE real node (DesignSurface)
// on the React Flow viewport shell (`@xyflow/react`, the substrate the owner
// locked and the D3 spike cleared). P2 adds the other two tiers: the REAL
// `FoundationSurface` and `ArchitectureSurface` render as their own lane nodes
// beside Design, so all three tiers sit side-by-side as React Flow nodes —
// positioned by P0's derived `computeLaneLayout` (STYLE_GUIDE §1 principle 4 /
// SPEC invariant 5 — position is a pure projection of `(tier, sort)`, never
// persisted). x is tier-indexed (LANE_ORDER: foundation, architecture, design),
// so the three nodes land in three columns automatically.
//
// It is mounted ONLY behind a dev-only flag (App.tsx `?d3rf` in a DEV build) —
// the normal app still renders `WorkspaceSurface`. P2 is intentionally NOT the
// constrained-drag → `sort` mutations (P3) or focus-pan / LOD (P4).
//
// Spike-proven annotations that are load-bearing here (all three lanes):
//   • each node's interactive body is wrapped in `nodrag nopan nowheel` — else a
//     pointerdown starts a node-drag instead of a cell edit (`nodrag`), and a
//     wheel zooms the canvas instead of scrolling the cell (`nowheel`);
//   • each node also carries a header `dragHandle` (`.wc-node__handle`) so the
//     ONLY thing that can start a node-drag is the header, never a grid body
//     (belt-and-suspenders with `nodrag`);
//   • `autoPanOnNodeDrag={false}` — the viewport must not chase a dragged node;
//   • each body records its tier on the D2 `activeLane` slice on focus/pointer,
//     so Design's `c`/`v`/`d` capture-phase verbs stay lane-scoped exactly as in
//     WorkspaceSurface (gate: `c` from Foundation must NOT compose a Design
//     draft; `c` with Design active must).

type WorkspaceRoute = Extract<AppRoute, { kind: 'project' | 'tier' | 'design' }>

// Estimated node heights for the derived layout — P2 does not measure the DOM
// (that is a later LOD/measure concern). With one node per lane every node's y is
// 0 regardless of the estimate; the heights only start to matter once P3 stacks
// multiple nodes per lane. They are kept honest (Design is the tallest tier).
const LANE_NODE_HEIGHT: Record<LaneTier, number> = {
  foundation: 700,
  architecture: 700,
  design: 1200,
}

// Human label on each lane's header drag-handle bar.
const LANE_LABEL: Record<LaneTier, string> = {
  foundation: 'Foundation',
  architecture: 'Architecture',
  design: 'Design',
}

// Lane geometry. `laneWidth` matches the `.wc-node` reading width so the real
// surfaces lay out identically inside their nodes; each column's x is a pure
// function of its tier index (LANE_ORDER).
const LANE_CONFIG: LaneLayoutConfig = { laneWidth: 960, laneGap: 48, nodeGap: 24 }

const LANE_NODE_ID: Record<LaneTier, string> = {
  foundation: 'workspace-canvas-foundation-lane',
  architecture: 'workspace-canvas-architecture-lane',
  design: 'workspace-canvas-design-lane',
}

// A `type` (not `interface`) on purpose: React Flow's `Node<Data>` constrains
// Data to `Record<string, unknown>`, which an object-literal type alias
// satisfies but an interface does not (interfaces lack an implicit index
// signature). eslint's consistent-type-definitions is waived for that reason.
// One generic data shape parameterized by `tier` — the surfaces take different
// props (Foundation/Architecture need only projectId; Design also needs
// contextPath / view / canvasId), so the node renders a per-tier surface off a
// single discriminant rather than three near-identical node components.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type LaneNodeData = {
  tier: LaneTier
  projectId: string
  contextPath: string[]
  view: DesignView
  canvasId: string | undefined
}

type LaneNode = Node<LaneNodeData, 'lane'>

// The custom node: a header drag-handle bar over the REAL tier surface. The body
// carries `nodrag nopan nowheel` (see file header) and records its lane active on
// focus/pointer so the D2 `activeLane` slice keeps gating Design's `c`/`v`/`d`
// verbs to the focused lane exactly as it does in WorkspaceSurface.
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
        {tier === 'architecture' && <ArchitectureSurface projectId={data.projectId} />}
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

// Stable across renders — React Flow warns (and remounts nodes) if nodeTypes is
// a fresh object each render. One generic type keyed by `tier` in `data`.
const NODE_TYPES = { lane: LaneNode }

export function WorkspaceCanvas({ route }: { route: WorkspaceRoute }) {
  const projectId = route.projectId
  // Same derivation as WorkspaceSurface: only a `design` route carries
  // contextPath / view / canvasId; other workspace routes open the root canvas.
  const design =
    route.kind === 'design'
      ? { contextPath: route.contextPath, view: route.view, canvasId: route.canvasId }
      : { contextPath: [] as string[], view: 'canvas' as const, canvasId: undefined }

  const initialNodes = useMemo<LaneNode[]>(() => {
    // One node per tier; x is tier-indexed by LANE_ORDER, so the three land in
    // three columns and an absent lane never shifts another's x.
    const positions = computeLaneLayout(
      LANE_ORDER.map((tier) => ({
        id: LANE_NODE_ID[tier],
        tier,
        sort: 0,
        height: LANE_NODE_HEIGHT[tier],
      })),
      LANE_CONFIG,
    )
    const posById = new Map(positions.map((p) => [p.id, p]))

    return LANE_ORDER.map((tier) => {
      const pos = posById.get(LANE_NODE_ID[tier])
      return {
        id: LANE_NODE_ID[tier],
        type: 'lane' as const,
        position: { x: pos?.x ?? 0, y: pos?.y ?? 0 },
        // Belt-and-suspenders with the body's `nodrag`: the ONLY drag origin is
        // the header handle. P3 wires the drag to a `sort` mutation; P2 leaves
        // it a no-op reorder gesture.
        dragHandle: '.wc-node__handle',
        data: {
          tier,
          projectId,
          // Only the Design lane consumes these; the others carry harmless roots.
          contextPath: tier === 'design' ? design.contextPath : [],
          view: tier === 'design' ? design.view : ('canvas' as const),
          canvasId: tier === 'design' ? design.canvasId : undefined,
        },
      }
    })
    // Recompute only when the route-derived inputs change.
  }, [projectId, design.contextPath, design.view, design.canvasId])

  const [nodes, , onNodesChange] = useNodesState<LaneNode>(initialNodes)

  return (
    <div className="workspace-canvas">
      <ReactFlow
        nodes={nodes}
        onNodesChange={onNodesChange}
        nodeTypes={NODE_TYPES}
        // Frame all three lanes into the pane on first paint (the three columns
        // are wide, so this settles below 1:1 — which is also the scale the
        // gate-c promote-popover test exercises).
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
