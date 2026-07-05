# ADR-0005: Hand-assembled SVG canvas with deterministic layout (no free-running physics)

- **Status**: Accepted
- **Date**: 2026-07-05

## Context

No charting library models the n-arc circle (arcs + parameter dots + centroid-placed contexts + spokes). Concern raised: hand-rolling canvas "physics" and responsive behavior. Position is meaningful-ish (centroid of bound parameters) but decorative; the hard invariant is **layout = pure fn(tree), deterministic, never stored**.

## Decision

- React + SVG components; **d3-shape** for arc geometry.
- **No physics simulation.** Node placement is the centroid of bound parameter dots. Collision resolution uses **d3-force run synchronously** inside the pure layout function (fixed ticks, collision-only, no randomness) — deterministic, and the solver is d3's maintained code.
- Layout computes in a fixed 1000×1000 abstract space; the SVG `viewBox` scales it to any container. Responsiveness is a labeling/chrome concern (STYLE_GUIDE § Canvas responsiveness), not geometry.
- **Designated fallback**: React Flow (xyflow) if M2 pan/zoom/drag interaction work overruns. Because layout is a pure function, it can feed either renderer; switching is contained.

## Consequences

- Deterministic snapshots make layout testable (SPEC §7) and keep positions off the sync wire.
- We own pan/zoom/drag pointer handling — the actual risk area; bounded by the React Flow fallback.
- Adding one context never reshuffles the canvas (a force layout would).
