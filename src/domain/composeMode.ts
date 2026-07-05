// Issue 010 — the pure state machine behind guided compose (SPEC §4.2/§4.4).
// The store holds the authoritative bindings; this reducer only decides which
// dimension the composer prompts next and whether *this* bind was the one that
// completed the tuple (so the caller can announce it exactly once). Kept pure
// and store-free for the same reason canvasLayout is: it is unit-testable in
// isolation and can never desync from React.
import { isComplete } from './completeness'

export interface ComposeState {
  // dimensionId -> parameterId, mirroring the store's per-context bindings.
  bindings: Record<string, string>
  // The dimension the composer highlights and prompts next; null once every
  // dimension is bound (nothing left to guide toward).
  activeDimensionId: string | null
}

export type ComposeAction =
  | { type: 'bind'; dimensionId: string; parameterId: string }
  | { type: 'unbind'; dimensionId: string }

export interface ComposeTransition {
  state: ComposeState
  // True only on the transition from incomplete -> complete, so completion is
  // announced exactly when the nth dimension binds and never again on re-binds.
  completed: boolean
}

function boundSet(bindings: Record<string, string>): Set<string> {
  return new Set(Object.keys(bindings))
}

// The first dimension in sort order without a binding, or null when complete.
// Exported because DesignSurface derives the displayed active dimension
// straight from the store's live bindings (race-free under rapid binds),
// rather than threading it through React state.
export function firstUnbound(
  dimensionIds: readonly string[],
  bindings: Readonly<Record<string, string>>,
): string | null {
  return dimensionIds.find((id) => !bindings[id]) ?? null
}

// The next unbound dimension scanning forward from `fromId` in sort order,
// wrapping past the end — this is what "advances to the next unbound
// dimension" means in the design brief. Null when all are bound.
function nextUnboundAfter(
  dimensionIds: readonly string[],
  bindings: Record<string, string>,
  fromId: string,
): string | null {
  const n = dimensionIds.length
  const start = dimensionIds.indexOf(fromId)
  if (start === -1) return firstUnbound(dimensionIds, bindings)
  for (let step = 1; step <= n; step++) {
    const candidate = dimensionIds[(start + step) % n]
    if (candidate && !bindings[candidate]) return candidate
  }
  return null
}

export function initialComposeState(dimensionIds: readonly string[]): ComposeState {
  return { bindings: {}, activeDimensionId: dimensionIds[0] ?? null }
}

export function composeReducer(
  dimensionIds: readonly string[],
  state: ComposeState,
  action: ComposeAction,
): ComposeTransition {
  const wasComplete = isComplete(dimensionIds, boundSet(state.bindings))

  if (action.type === 'unbind') {
    const { [action.dimensionId]: _removed, ...bindings } = state.bindings
    void _removed
    return {
      state: { bindings, activeDimensionId: action.dimensionId },
      completed: false,
    }
  }

  const bindings = { ...state.bindings, [action.dimensionId]: action.parameterId }
  const nowComplete = isComplete(dimensionIds, boundSet(bindings))
  return {
    state: {
      bindings,
      activeDimensionId: nextUnboundAfter(dimensionIds, bindings, action.dimensionId),
    },
    completed: !wasComplete && nowComplete,
  }
}
