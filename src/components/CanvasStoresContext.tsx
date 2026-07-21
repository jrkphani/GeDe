import { createContext, useContext } from 'react'
import { getCanvasStores, type CanvasStores } from '../store/canvasStores'

// Issue 100 Phase B — the injection seam for per-canvas store instances. A live
// core (DesignCoreAdapter) resolves its `CanvasStores` via `resolveCanvasStores`
// and threads it down to `ContextRegister` / `DimensionManager` through this
// context. The `?? getCanvasStores(null)` default is LOAD-BEARING: those same
// children are also rendered by the flag-off `DesignSurface` fallback, which
// provides NO provider — there they must keep resolving the process-lifetime
// default instance (reference-identical to the `useContextsStore` shims), so the
// swap is byte-identical to the pre-refactor singleton. Phase C is what makes a
// provider inject a non-default instance for a child canvas.
const CanvasStoresContext = createContext<CanvasStores | null>(null)

export function useCanvasStores(): CanvasStores {
  return useContext(CanvasStoresContext) ?? getCanvasStores(null)
}

export const CanvasStoresProvider = CanvasStoresContext.Provider
