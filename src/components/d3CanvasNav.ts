import { useActiveLaneStore } from '../store/activeLane'
import type { LaneTier } from '../domain/laneLayout'

// 089-D3 — the ⌘1/2/3 pan-to-lane interceptor, split OUT of WorkspaceCanvas.tsx
// into this tiny, eagerly-imported module. This file has NO `@xyflow/react`
// import and NO CSS: App.tsx imports it eagerly (for the register-first ordering
// below), and because it pulls in zero React Flow, importing it costs the
// production bundle nothing. The heavy WorkspaceCanvas (which DOES import
// `@xyflow/react` + its ~18.6 KB stylesheet) is `React.lazy`-loaded and gated on
// `import.meta.env.DEV`, so in a prod build it is never imported — no React Flow
// JS AND no CSS ship. WorkspaceCanvas publishes its live viewport handle into
// `activeCanvasInstance` here on mount (and clears it on unmount).

export const LANE_NODE_ID: Record<LaneTier, string> = {
  foundation: 'workspace-canvas-foundation-lane',
  architecture: 'workspace-canvas-architecture-lane',
  design: 'workspace-canvas-design-lane',
}

// 089-D3 P4 (nav layer) — ⌘1/2/3 maps to a lane, exactly as AppShell's global
// route-navigate does (Digit1→foundation, Digit2→architecture, Digit3→design).
// On the canvas these must PAN, not navigate — see onCanvasNavKeydown.
const DIGIT_TO_TIER: Record<string, LaneTier | undefined> = {
  Digit1: 'foundation',
  Digit2: 'architecture',
  Digit3: 'design',
}

// Frame a single lane node with a little breathing room when jumping to it.
const LANE_FIT_PADDING = 0.16
// Animation duration (ms). Reduced-motion snaps to 0 (STYLE_GUIDE §8 —
// "the app never animates what it can simply do").
const LANE_JUMP_DURATION = 450

// matchMedia is in the DOM lib types but absent under jsdom — read it through
// Partial<Window> so the presence check is a real runtime guard (mirrors
// shell/laneTarget.ts). Under reduced-motion every pan snaps (duration 0).
export function prefersReducedMotion(): boolean {
  const matchMedia = (window as Partial<Window>).matchMedia
  return matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

// The minimal slice of the React Flow instance the interceptor needs — typed
// loosely on purpose so this module never imports `@xyflow/react`. The real
// `ReactFlowInstance.fitView` (a superset) satisfies this; WorkspaceCanvas
// publishes an adapter that forwards to it (see setActiveCanvasInstance).
export interface CanvasNavInstance {
  fitView: (options: { nodes: { id: string }[]; padding: number; duration: number }) => unknown
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
// is hopelessly second. Registering at MODULE-EVAL time (App.tsx imports this
// module eagerly, before any component mounts) guarantees this listener is added
// before AppShell's mount-effect listener, so it wins. `stopImmediatePropagation`
// (not just `stopPropagation`) is required because both listeners sit on the
// SAME target (window). The listener is inert (early return) unless a canvas is
// mounted and has published its instance below, so the normal flag-off app —
// and production, where the canvas never mounts — is byte-for-byte unaffected.
let activeCanvasInstance: CanvasNavInstance | null = null

// WorkspaceCanvas publishes its live viewport handle on mount and clears it on
// unmount. The clear is identity-guarded so a stale unmount can never null out a
// newer canvas's instance.
export function setActiveCanvasInstance(instance: CanvasNavInstance): void {
  activeCanvasInstance = instance
}

export function clearActiveCanvasInstance(instance: CanvasNavInstance): void {
  if (activeCanvasInstance === instance) activeCanvasInstance = null
}

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
