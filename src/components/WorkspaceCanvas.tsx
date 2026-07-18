import { useCallback, useEffect, useMemo, useRef, type FocusEvent } from 'react'
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
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

// 089-D3 P4 (nav layer) — ⌘1/2/3 maps to a lane, exactly as AppShell's global
// route-navigate does (Digit1→foundation, Digit2→architecture, Digit3→design).
// On the canvas these must PAN, not navigate — see WorkspaceCanvasInner.
const DIGIT_TO_TIER: Record<string, LaneTier | undefined> = {
  Digit1: 'foundation',
  Digit2: 'architecture',
  Digit3: 'design',
}

// Frame a single lane node with a little breathing room when jumping to it.
const LANE_FIT_PADDING = 0.16
// Animation durations (ms). Reduced-motion snaps both to 0 (STYLE_GUIDE §8 —
// "the app never animates what it can simply do").
const LANE_JUMP_DURATION = 450
const FOCUS_PAN_DURATION = 320
// Focus-driven pan is pan-if-outside-margin, NOT center-on-every-focus: only
// pan when the focused element is within this many px of (or past) a pane edge,
// so the viewport never fights a typist whose caret is already comfortably in
// view (D3 spike finding — "center on every focus is too jerky").
const FOCUS_PAN_MARGIN = 88

// matchMedia is in the DOM lib types but absent under jsdom — read it through
// Partial<Window> so the presence check is a real runtime guard (mirrors
// shell/laneTarget.ts). Under reduced-motion every pan snaps (duration 0).
function prefersReducedMotion(): boolean {
  const matchMedia = (window as Partial<Window>).matchMedia
  return matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

// ── ⌘1/2/3 pan-to-lane interceptor (module-level, capture phase) ────────────
// WHY module-level and not a component effect: AppShell owns a GLOBAL
// window-capture ⌘1/2/3 handler that calls navigate(), which rebuilds the URL
// via serializeRoute and DROPS the `?d3rf` param — exiting the canvas. To keep
// `?d3rf`, the canvas must intercept ⌘1/2/3 FIRST and stop the event before
// AppShell's listener runs. DOM invokes same-target capture listeners in
// REGISTRATION order, so "first" means "added before AppShell's". AppShell
// mounts (and registers) before the canvas does — the canvas is gated behind the
// DB-ready surface, AppShell is always mounted — so a canvas *effect* listener
// is hopelessly second. Registering at MODULE-EVAL time (this file is imported
// by App.tsx before any component mounts) guarantees this listener is added
// before AppShell's mount-effect listener, so it wins. `stopImmediatePropagation`
// (not just `stopPropagation`) is required because both listeners sit on the
// SAME target (window). The listener is inert (early return) unless a canvas is
// mounted and has published its instance below, so the normal flag-off app —
// and production, where the canvas never mounts — is byte-for-byte unaffected.
let activeCanvasInstance: ReactFlowInstance<LaneNode> | null = null

function onCanvasNavKeydown(e: KeyboardEvent): void {
  const instance = activeCanvasInstance
  if (!instance) return
  if (!(e.metaKey || e.ctrlKey)) return
  const tier = DIGIT_TO_TIER[e.code]
  if (!tier) return
  // Win over AppShell's global navigate() — keep the canvas (and `?d3rf`).
  e.preventDefault()
  e.stopImmediatePropagation()
  const duration = prefersReducedMotion() ? 0 : LANE_JUMP_DURATION
  void instance.fitView({ nodes: [{ id: LANE_NODE_ID[tier] }], padding: LANE_FIT_PADDING, duration })
  // Mirror AppShell / D2: the keyboard lane-jump also makes the lane ACTIVE, so
  // Design's `c`/`v`/`d` verbs scope to it without needing focus to land.
  useActiveLaneStore.getState().setActiveLane(tier)
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onCanvasNavKeydown, true)
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

// The exported shell wraps the canvas in a ReactFlowProvider so both the
// imperative viewport handle (`useReactFlow`, for ⌘1/2/3 pan-to-lane) and the
// focus-pan handler live inside the RF context — cleaner than threading an
// `onInit` instance ref, and it lets the focus handler sit on the wrapping
// element (outside <ReactFlow> itself) while still calling `screenToFlowPosition`
// / `setCenter`.
export function WorkspaceCanvas({ route }: { route: WorkspaceRoute }) {
  return (
    <ReactFlowProvider>
      <WorkspaceCanvasInner route={route} />
    </ReactFlowProvider>
  )
}

function WorkspaceCanvasInner({ route }: { route: WorkspaceRoute }) {
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

  const [nodes, setNodes, onNodesChange] = useNodesState<LaneNode>(initialNodes)

  // Code-review HIGH fix: `useNodesState(initialNodes)` wraps `useState`, so it
  // seeds from `initialNodes` ONLY on the first render — every later value is
  // discarded. Without this re-sync the mounted nodes' `data` (projectId /
  // contextPath / view / canvasId) freezes at mount, so while `?d3rf` persists a
  // Design drill-down, a project switch, or a canvas switch would silently stop
  // updating the co-mounted surfaces (the canvas keeps showing the mount-time
  // context). Re-patch each node's `data` from the freshly-recomputed
  // `initialNodes` whenever the route-derived inputs change; positions are left
  // as-is (derived + stable) so the viewport is never jarred.
  useEffect(() => {
    setNodes((prev) => {
      const next = prev.map((n) => {
        const fresh = initialNodes.find((i) => i.id === n.id)
        if (!fresh) return n
        const d = n.data
        const f = fresh.data
        const same =
          d.projectId === f.projectId &&
          d.contextPath === f.contextPath &&
          d.view === f.view &&
          d.canvasId === f.canvasId
        return same ? n : { ...n, data: f }
      })
      // Return the SAME array reference when nothing changed so this never
      // churns node identity on mount (where prev.data === initialNodes.data) —
      // a redundant re-render would disrupt fitView / focus-pan.
      return next.some((n, i) => n !== prev[i]) ? next : prev
    })
  }, [initialNodes, setNodes])

  // Imperative viewport handle (stable across renders). Available because this
  // component is rendered inside the <ReactFlowProvider> above.
  const reactFlow = useReactFlow<LaneNode>()
  // The pane wrapper — its rect is the on-screen viewport bounds the focus-pan
  // margin test is measured against.
  const wrapperRef = useRef<HTMLDivElement>(null)

  // ⌘1/2/3 → pan/zoom to the Foundation / Architecture / Design lane node.
  // The actual key listener is the MODULE-LEVEL interceptor (see below); this
  // effect just registers this canvas's live React Flow instance as the active
  // pan target for as long as the canvas is mounted. On unmount it clears it, so
  // the interceptor falls dormant and AppShell's global ⌘1/2/3 route-navigate
  // resumes for the normal (flag-off) app.
  useEffect(() => {
    activeCanvasInstance = reactFlow
    return () => {
      if (activeCanvasInstance === reactFlow) activeCanvasInstance = null
    }
  }, [reactFlow])

  // Focus-driven pan (D3 spike gate-d): native `scrollIntoView` is a no-op on a
  // transformed plane, so focusing a cell/editor inside a node needs an explicit
  // pan. Heuristic is pan-if-outside-margin, never center-on-every-focus: if the
  // focused element sits comfortably inside the pane (>= FOCUS_PAN_MARGIN from
  // every edge) we leave the viewport alone so bulk keyboard entry is never
  // yanked around; only when it is near/past an edge do we `setCenter` on it —
  // keeping the CURRENT zoom (pan, don't re-zoom). Reduced-motion snaps.
  const onFocusCapture = useCallback(
    (e: FocusEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null
      const pane = wrapperRef.current
      if (!target || !pane || typeof target.getBoundingClientRect !== 'function') return
      const r = target.getBoundingClientRect()
      // A zero-box target (e.g. the focus-forwarding wrapper itself) can't be
      // meaningfully off-screen — skip.
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

  return (
    <div className="workspace-canvas" ref={wrapperRef} onFocusCapture={onFocusCapture}>
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
