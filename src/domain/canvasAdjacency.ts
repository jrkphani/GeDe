// Issue 028(a) — pure adjacency predicate backing canvas hover/focus emphasis
// (STYLE_GUIDE §7 "Focus + adjacency", amended; ADR-0005 pure/deterministic
// layout). Given a single emphasised mark (a context node, parameter dot, or
// dimension arc), returns the ids that should stay at full opacity; Canvas.tsx
// mutes everything else to `--canvas-muted`. Pure and DOM-free so it's
// unit-testable without React or a store.
//
// Deliberately asymmetric per role — matches the issue's design brief
// literally, not a generalized "everything touching this" closure:
//   context   -> its bound dots (by dot key). No arcs, no other contexts.
//   parameter -> every context bound to it. No dots, no arcs.
//   dimension -> every one of its parameter dots (bound or not, so an unused
//                parameter still highlights) + the contexts bound within it.
//                No other dimensions.
// The emphasised mark's own identity is folded into its own role's set for
// 'context' and 'dimension' (so a hovered node/arc is trivially "adjacent to
// itself" and never fades). A hovered *parameter* dot is the one case that
// isn't folded in this way — Canvas.tsx applies its own self-check there,
// since deriving "which dimension is this parameter's own dot on" would
// require scanning bindings and would come up empty for an unused parameter
// (a boundary case this module is specifically tested against).

export type CanvasEmphasisRole = 'context' | 'parameter' | 'dimension'

export interface CanvasEmphasis {
  id: string
  role: CanvasEmphasisRole
}

export interface AdjacencyDot {
  dimensionId: string
  parameterId: string
}

export interface AdjacencyInput {
  bindingsByContext: Readonly<Record<string, Readonly<Record<string, string>>>>
  dots: readonly AdjacencyDot[]
}

export interface AdjacentSet {
  contextIds: ReadonlySet<string>
  dotKeys: ReadonlySet<string>
  dimensionIds: ReadonlySet<string>
}

const EMPTY_IDS: ReadonlySet<string> = new Set()

export const EMPTY_ADJACENT_SET: AdjacentSet = {
  contextIds: EMPTY_IDS,
  dotKeys: EMPTY_IDS,
  dimensionIds: EMPTY_IDS,
}

// Shared key format for a parameter dot, also used by Canvas.tsx's own
// position lookup (`dotPositionByKey`) — keep the two in lockstep.
export function dotKey(dimensionId: string, parameterId: string): string {
  return `${dimensionId}:${parameterId}`
}

export function adjacentSet(emphasis: CanvasEmphasis | null, input: AdjacencyInput): AdjacentSet {
  if (!emphasis) return EMPTY_ADJACENT_SET
  const { bindingsByContext, dots } = input

  if (emphasis.role === 'context') {
    const bindings = bindingsByContext[emphasis.id] ?? {}
    const dotKeys = new Set<string>()
    for (const [dimensionId, parameterId] of Object.entries(bindings)) {
      dotKeys.add(dotKey(dimensionId, parameterId))
    }
    return { contextIds: new Set([emphasis.id]), dotKeys, dimensionIds: EMPTY_IDS }
  }

  if (emphasis.role === 'parameter') {
    const contextIds = new Set<string>()
    for (const [contextId, bindings] of Object.entries(bindingsByContext)) {
      if (Object.values(bindings).includes(emphasis.id)) contextIds.add(contextId)
    }
    return { contextIds, dotKeys: EMPTY_IDS, dimensionIds: EMPTY_IDS }
  }

  // dimension
  const dotKeys = new Set<string>()
  for (const dot of dots) {
    if (dot.dimensionId === emphasis.id) dotKeys.add(dotKey(dot.dimensionId, dot.parameterId))
  }
  const contextIds = new Set<string>()
  for (const [contextId, bindings] of Object.entries(bindingsByContext)) {
    const parameterId = bindings[emphasis.id]
    if (parameterId) contextIds.add(contextId)
  }
  return { contextIds, dotKeys, dimensionIds: new Set([emphasis.id]) }
}
