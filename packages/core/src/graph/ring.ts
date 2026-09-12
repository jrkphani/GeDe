/**
 * Ring layout (GRAPH-07): one arc per dimension with a dot per parameter,
 * contexts on concentric orbits inside the arcs (1, 6, 12, 18 …). Laid out
 * in a fixed 520-unit space that the SVG scales to its box (GRAPH-11 "the
 * ring scales to fit its box"); nothing here knows about pixels or zoom.
 * Geometry follows the handover prototype's ring, which the PRD's prose
 * describes; where the two differ the PRD wins (recorded in the PR).
 */
import type { Id } from '../ids.js';
import type { GraphDerivation } from './derive.js';

/** The layout space: centre and ring radius; the viewBox adds `RING_MARGIN` on every side for labels. */
export const RING_SIZE = 520;
export const RING_CENTRE = RING_SIZE / 2;
export const RING_RADIUS = 200;
export const RING_MARGIN = 40;
/** Gap between neighbouring arcs, in radians. */
export const ARC_GAP = 0.18;
/** Radius of a dimension label and of a parameter label beyond the ring. */
export const ARC_LABEL_OFFSET = 36;
export const DOT_LABEL_OFFSET = 16;
export const DOT_RADIUS = 6;
export const DOT_RADIUS_EMPHASISED = 8;
/** Orbit spacing: at most this, else what fits inside the arcs. */
export const ORBIT_STEP_MAX = 46;
export const ORBIT_INSET = 50;
/** Each orbit is turned by this many radians per orbit index so nodes do not line up radially. */
export const ORBIT_TWIST = 0.35;
export const NODE_RADIUS = 16;
export const NODE_RADIUS_DENSE = 12;
/** Above this many contexts the nodes shrink to the dense radius. */
export const DENSE_CONTEXTS = 12;
/** Labels longer than this are cut to `TRUNCATE_TO` characters plus an ellipsis. */
export const LABEL_MAX = 14;
export const TRUNCATE_TO = 13;

export type TextAnchor = 'start' | 'middle' | 'end';

export interface RingPoint {
  readonly x: number;
  readonly y: number;
}

export interface RingArc {
  readonly dimensionId: Id;
  readonly index: number;
  readonly label: string;
  /** SVG path data. */
  readonly d: string;
  readonly labelAt: RingPoint;
  readonly anchor: TextAnchor;
  readonly startAngle: number;
  readonly endAngle: number;
}

export interface RingDot {
  readonly key: string;
  readonly dimensionId: Id;
  readonly dimensionIndex: number;
  readonly value: string;
  readonly at: RingPoint;
  readonly angle: number;
  readonly label: string;
  readonly labelAt: RingPoint;
  readonly anchor: TextAnchor;
}

export interface RingNode {
  readonly contextId: Id;
  readonly symbol: string;
  readonly complete: boolean;
  readonly at: RingPoint;
  readonly orbit: number;
  readonly radius: number;
}

export interface RingLayout {
  readonly arcs: readonly RingArc[];
  readonly dots: readonly RingDot[];
  readonly nodes: readonly RingNode[];
  /** Node radius in use (dense past `DENSE_CONTEXTS`). */
  readonly nodeRadius: number;
  /** `viewBox` for the SVG: the space plus the label margin. */
  readonly viewBox: string;
}

export interface RingSpoke {
  readonly contextId: Id;
  readonly dotKey: string;
  readonly dimensionIndex: number;
  readonly d: string;
}

export function polar(angle: number, radius: number): RingPoint {
  return { x: RING_CENTRE + Math.cos(angle) * radius, y: RING_CENTRE + Math.sin(angle) * radius };
}

function anchorFor(cos: number, deadBand: number): TextAnchor {
  return cos > deadBand ? 'start' : cos < -deadBand ? 'end' : 'middle';
}

export function truncateLabel(text: string): string {
  const chars = Array.from(text);
  return chars.length > LABEL_MAX ? `${chars.slice(0, TRUNCATE_TO).join('')}…` : text;
}

const fmt = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * Orbit assignment: orbit 0 holds one context at the centre, orbit k holds
 * 6k. Returns `{ orbit, slot, slots }` per context in order.
 */
export function orbitsFor(count: number): { orbit: number; slot: number; slots: number }[] {
  const out: { orbit: number; slot: number; slots: number }[] = [];
  let placed = 0;
  let k = 0;
  while (placed < count) {
    const capacity = k === 0 ? 1 : 6 * k;
    const n = Math.min(capacity, count - placed);
    for (let j = 0; j < n; j += 1) out.push({ orbit: k, slot: j, slots: n });
    placed += n;
    k += 1;
  }
  return out;
}

/** Lay out a derivation. Deterministic: the same derivation yields the same layout. */
export function ringLayout(derivation: GraphDerivation): RingLayout {
  const dims = derivation.dimensions;
  const n = Math.max(1, dims.length);
  const span = (Math.PI * 2) / n;
  const arcs: RingArc[] = [];
  const dots: RingDot[] = [];
  dims.forEach((d, i) => {
    const a0 = -Math.PI / 2 + i * span + ARC_GAP / 2;
    const a1 = a0 + span - ARC_GAP;
    const p0 = polar(a0, RING_RADIUS);
    const p1 = polar(a1, RING_RADIUS);
    const mid = (a0 + a1) / 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    arcs.push({
      dimensionId: d.id,
      index: i,
      label: d.label,
      d: `M ${fmt(p0.x)} ${fmt(p0.y)} A ${String(RING_RADIUS)} ${String(RING_RADIUS)} 0 ${String(large)} 1 ${fmt(p1.x)} ${fmt(p1.y)}`,
      labelAt: polar(mid, RING_RADIUS + ARC_LABEL_OFFSET),
      anchor: anchorFor(Math.cos(mid), 0.2),
      startAngle: a0,
      endAngle: a1,
    });
    d.parameters.forEach((p, k) => {
      const angle = a0 + (a1 - a0) * ((k + 0.5) / d.parameters.length);
      const labelAt = polar(angle, RING_RADIUS + DOT_LABEL_OFFSET);
      dots.push({
        key: p.key,
        dimensionId: d.id,
        dimensionIndex: i,
        value: p.value,
        at: polar(angle, RING_RADIUS),
        angle,
        label: truncateLabel(p.value),
        labelAt: { x: labelAt.x, y: labelAt.y + 3 },
        anchor: anchorFor(Math.cos(angle), 0.25),
      });
    });
  });
  const contexts = derivation.contexts;
  const orbits = orbitsFor(contexts.length);
  const orbitCount = orbits.length === 0 ? 1 : (orbits[orbits.length - 1]?.orbit ?? 0) + 1;
  const step = Math.min(ORBIT_STEP_MAX, (RING_RADIUS - ORBIT_INSET) / Math.max(1, orbitCount - 1));
  const nodeRadius = contexts.length > DENSE_CONTEXTS ? NODE_RADIUS_DENSE : NODE_RADIUS;
  const nodes: RingNode[] = contexts.map((c, i) => {
    const o = orbits[i] ?? { orbit: 0, slot: 0, slots: 1 };
    const at =
      o.orbit === 0
        ? { x: RING_CENTRE, y: RING_CENTRE }
        : polar(
            -Math.PI / 2 + (o.slot / o.slots) * Math.PI * 2 + o.orbit * ORBIT_TWIST,
            o.orbit * step,
          );
    return {
      contextId: c.id,
      symbol: c.symbol,
      complete: c.complete,
      at,
      orbit: o.orbit,
      radius: nodeRadius,
    };
  });
  return {
    arcs,
    dots,
    nodes,
    nodeRadius,
    viewBox: `${String(-RING_MARGIN)} ${String(-RING_MARGIN)} ${String(RING_SIZE + 2 * RING_MARGIN)} ${String(RING_SIZE + 2 * RING_MARGIN)}`,
  };
}

/**
 * Spokes from a context's node to each of its bound parameters (GRAPH-09):
 * a quadratic curve bowed a little sideways so overlapping spokes read apart.
 */
export function spokesFor(
  layout: RingLayout,
  derivation: GraphDerivation,
  contextId: Id,
): RingSpoke[] {
  const node = layout.nodes.find((n) => n.contextId === contextId);
  const context = derivation.contexts.find((c) => c.id === contextId);
  if (node === undefined || context === undefined) return [];
  const dotByKey = new Map(layout.dots.map((d) => [d.key, d]));
  const out: RingSpoke[] = [];
  derivation.dimensions.forEach((d, i) => {
    const value = context.bindings[i];
    if (value === null || value === undefined) return;
    const dot = dotByKey.get(`${d.id}|${value}`);
    if (dot === undefined) return;
    const mx = (node.at.x + dot.at.x) / 2 + (RING_CENTRE - dot.at.y) * 0.12;
    const my = (node.at.y + dot.at.y) / 2 + (dot.at.x - RING_CENTRE) * 0.12;
    out.push({
      contextId,
      dotKey: dot.key,
      dimensionIndex: i,
      d: `M ${fmt(node.at.x)} ${fmt(node.at.y)} Q ${fmt(mx)} ${fmt(my)} ${fmt(dot.at.x)} ${fmt(dot.at.y)}`,
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Emphasis (GRAPH-09): what is adjacent to a hovered context or parameter,
// across the whole pair.
// ---------------------------------------------------------------------------

export type GraphEmphasis =
  | { readonly role: 'context'; readonly id: Id }
  | { readonly role: 'parameter'; readonly key: string };

export interface GraphAdjacency {
  readonly contextIds: ReadonlySet<Id>;
  readonly dotKeys: ReadonlySet<string>;
}

export const NO_ADJACENCY: GraphAdjacency = { contextIds: new Set(), dotKeys: new Set() };

export function adjacencyOf(
  derivation: GraphDerivation,
  emphasis: GraphEmphasis | null,
): GraphAdjacency {
  if (emphasis === null) return NO_ADJACENCY;
  const contextIds = new Set<Id>();
  const dotKeys = new Set<string>();
  if (emphasis.role === 'context') {
    const c = derivation.contexts.find((x) => x.id === emphasis.id);
    if (c === undefined) return NO_ADJACENCY;
    contextIds.add(c.id);
    derivation.dimensions.forEach((d, i) => {
      const value = c.bindings[i];
      if (value !== null && value !== undefined) dotKeys.add(`${d.id}|${value}`);
    });
    return { contextIds, dotKeys };
  }
  dotKeys.add(emphasis.key);
  for (const d of derivation.dimensions) {
    const p = d.parameters.find((x) => x.key === emphasis.key);
    if (p === undefined) continue;
    for (const id of p.contextIds) contextIds.add(id);
  }
  return { contextIds, dotKeys };
}
