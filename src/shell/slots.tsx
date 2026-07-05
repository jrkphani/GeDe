import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// The context bar is a shell-owned slot (SITEMAP §2): tiers fill it by
// rendering <ContextBar>…</ContextBar> in their surface; the band collapses
// when nothing fills it. Feature surfaces depend on this component only —
// never on shell internals (issue 016 acceptance). Content flows through a
// portal, so the slot never re-enters React state during render.

interface SlotApi {
  el: HTMLDivElement | null
  setEl: (el: HTMLDivElement | null) => void
  count: number
  add: () => void
  remove: () => void
}

const ContextBarContext = createContext<SlotApi | null>(null)

export function ContextBarProvider({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [count, setCount] = useState(0)
  return (
    <ContextBarContext.Provider
      value={{
        el,
        setEl,
        count,
        add: () => setCount((c) => c + 1),
        remove: () => setCount((c) => c - 1),
      }}
    >
      {children}
    </ContextBarContext.Provider>
  )
}

export function ContextBarSlot() {
  const api = useContext(ContextBarContext)
  if (api === null) return null
  return <div className="context-bar" ref={api.setEl} hidden={api.count === 0} />
}

export function ContextBar({ children }: { children: ReactNode }) {
  const api = useContext(ContextBarContext)
  useEffect(() => {
    if (!api) return
    api.add()
    return () => api.remove()
    // register once per mount — `api` is provider-stable; re-running would
    // double-register. Intentional, reviewed (issue 020).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (api?.el == null) return null
  return createPortal(children, api.el)
}
