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
import { computeLaneLayout, type LaneLayoutConfig } from '../domain/laneLayout'
import { useActiveLaneStore } from '../store/activeLane'
import type { AppRoute, DesignView } from '../shell/routes'
import { DesignSurface } from './DesignSurface'

// 089-D3 P1 — the React Flow viewport shell + ONE real node. This mounts the
// pan/zoom canvas (React Flow / `@xyflow/react`, the substrate the owner locked
// and the D3 spike cleared) with the REAL `DesignSurface` inside a single custom
// node, positioned by P0's derived `computeLaneLayout` (STYLE_GUIDE §1 principle
// 4 / SPEC invariant 5 — position is a pure projection of `(tier, sort)`, never
// persisted). Its job for P1 is gate (a): prove `EditableGrid`'s Numbers-grammar
// keyboard contract survives inside a node at viewport scale ≠ 1.
//
// It is mounted ONLY behind a dev-only flag (App.tsx `?d3rf` in a DEV build) —
// the normal app still renders `WorkspaceSurface`. P1 is intentionally NOT the
// three lanes (P2), constrained-drag → `sort` mutations (P3), or focus-pan / LOD
// (P4).
//
// Spike-proven annotations that are load-bearing here:
//   • the node's interactive body is wrapped in `nodrag nopan nowheel` — else a
//     pointerdown starts a node-drag instead of a cell edit (`nodrag`), and a
//     wheel zooms the canvas instead of scrolling the cell (`nowheel`);
//   • the node also carries a header `dragHandle` (`.wc-node__handle`) so the
//     ONLY thing that can start a node-drag is the header, never the grid body
//     (belt-and-suspenders with `nodrag`);
//   • `autoPanOnNodeDrag={false}` — the viewport must not chase a dragged node.

type WorkspaceRoute = Extract<AppRoute, { kind: 'project' | 'tier' | 'design' }>

// Estimated node height for the derived layout — P1 does not measure the DOM
// (that is a later LOD/measure concern); a lane with one node only needs a
// non-overlapping y, and a single node's y is 0 regardless of the estimate.
const DESIGN_NODE_HEIGHT = 1200

// Lane geometry. `laneWidth` matches the Design lane's D2 reading width so the
// real surface lays out identically inside the node; the design column's x is a
// pure function of its tier index (LANE_ORDER), so the single node lands at the
// third column even with the other two lanes absent (P2 adds them).
const LANE_CONFIG: LaneLayoutConfig = { laneWidth: 960, laneGap: 48, nodeGap: 24 }

const DESIGN_NODE_ID = 'workspace-canvas-design-lane'

// A `type` (not `interface`) on purpose: React Flow's `Node<Data>` constrains
// Data to `Record<string, unknown>`, which an object-literal type alias
// satisfies but an interface does not (interfaces lack an implicit index
// signature). eslint's consistent-type-definitions is waived for that reason.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type DesignNodeData = {
  projectId: string
  contextPath: string[]
  view: DesignView
  canvasId: string | undefined
}

type DesignNode = Node<DesignNodeData, 'designLane'>

// The custom node: a header drag-handle bar over the REAL DesignSurface. The
// body carries `nodrag nopan nowheel` (see file header) and records the Design
// lane active on focus/pointer so the D2 `activeLane` slice keeps gating Design's
// `c`/`v`/`d` verbs exactly as it does in WorkspaceSurface.
function DesignLaneNode({ data }: NodeProps<DesignNode>) {
  const setActiveLane = useActiveLaneStore((s) => s.setActiveLane)
  return (
    <div className="wc-node">
      <div className="wc-node__handle" aria-hidden="true">
        Design
      </div>
      <div
        className="nodrag nopan nowheel wc-node__body"
        onFocusCapture={() => setActiveLane('design')}
        onPointerDown={() => setActiveLane('design')}
      >
        <DesignSurface
          projectId={data.projectId}
          contextPath={data.contextPath}
          view={data.view}
          canvasId={data.canvasId}
        />
      </div>
    </div>
  )
}

// Stable across renders — React Flow warns (and remounts nodes) if nodeTypes is
// a fresh object each render.
const NODE_TYPES = { designLane: DesignLaneNode }

export function WorkspaceCanvas({ route }: { route: WorkspaceRoute }) {
  const projectId = route.projectId
  // Same derivation as WorkspaceSurface: only a `design` route carries
  // contextPath / view / canvasId; other workspace routes open the root canvas.
  const design =
    route.kind === 'design'
      ? { contextPath: route.contextPath, view: route.view, canvasId: route.canvasId }
      : { contextPath: [] as string[], view: 'canvas' as const, canvasId: undefined }

  const initialNodes = useMemo<DesignNode[]>(() => {
    const [position] = computeLaneLayout(
      [{ id: DESIGN_NODE_ID, tier: 'design', sort: 0, height: DESIGN_NODE_HEIGHT }],
      LANE_CONFIG,
    )
    return [
      {
        id: DESIGN_NODE_ID,
        type: 'designLane',
        position: { x: position?.x ?? 0, y: position?.y ?? 0 },
        // Belt-and-suspenders with the body's `nodrag`: the ONLY drag origin is
        // the header handle. P3 wires the drag to a `sort` mutation; P1 leaves
        // it a no-op reorder gesture.
        dragHandle: '.wc-node__handle',
        data: {
          projectId,
          contextPath: design.contextPath,
          view: design.view,
          canvasId: design.canvasId,
        },
      },
    ]
    // Recompute only when the route-derived inputs change.
  }, [projectId, design.contextPath, design.view, design.canvasId])

  const [nodes, , onNodesChange] = useNodesState<DesignNode>(initialNodes)

  // The single node is positioned at the Design column (x ≈ 2·stride); translate
  // the viewport so it is visible at 1:1 on first paint. The test zooms away from
  // this to exercise the grammar at scale ≠ 1.
  const defaultViewport = useMemo(
    () => ({ x: -(nodes[0]?.position.x ?? 0) + 24, y: 24, zoom: 1 }),
    [nodes],
  )

  return (
    <div className="workspace-canvas">
      <ReactFlow
        nodes={nodes}
        onNodesChange={onNodesChange}
        nodeTypes={NODE_TYPES}
        defaultViewport={defaultViewport}
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
