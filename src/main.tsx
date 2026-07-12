import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles/tokens.css'
import './styles/theme-bridge.css'
import './styles/base.css'
import App from './App'
import { initTheme } from './shell/theme'
import { getDatabase } from './db/client'
import { useSyncStore } from './store/sync'

// TEMPORARY (issue 077 diagnosis) — a hard, non-reproducible-locally
// read-path materialization bug: rows stream in from Electric (0 502s post
// 076) but the Design tier doesn't render and Foundation/Architecture render
// flakily, and production exposes no handle to inspect local PGlite or the
// sync store from a live session. Gated OFF by default (no window pollution,
// no perf cost) — enable per-session via `?__introspect=1`, or per-build via
// VITE_DEBUG_INTROSPECT=true. Remove this once 077 is closed.
function installDebugIntrospection(): void {
  const enabled =
    import.meta.env.VITE_DEBUG_INTROSPECT === 'true' ||
    new URLSearchParams(window.location.search).has('__introspect')
  if (!enabled) return

  void getDatabase().then(({ pg }) => {
    interface GedeDebugHandle {
      query: (sql: string) => Promise<Record<string, unknown>[]>
      syncState: () => {
        hasError: boolean
        enabled: boolean
        pendingCount: number
        appliedAt: {
          invitations: number
          members: number
          projects: number
          dimensions: number
          parameters: number
          contexts: number
          bindings: number
          tier1: number
          tier2: number
        }
        upToDateTables: string[]
      }
    }
    ;(window as typeof window & { __gede?: GedeDebugHandle }).__gede = {
      query: async (sql) => (await pg.query<Record<string, unknown>>(sql)).rows,
      syncState: () => {
        const s = useSyncStore.getState()
        return {
          hasError: s.hasError,
          enabled: s.enabled,
          pendingCount: s.pendingCount,
          appliedAt: {
            invitations: s.invitationsAppliedAt,
            members: s.membersAppliedAt,
            projects: s.projectsAppliedAt,
            dimensions: s.dimensionsAppliedAt,
            parameters: s.parametersAppliedAt,
            contexts: s.contextsAppliedAt,
            bindings: s.bindingsAppliedAt,
            tier1: s.tier1AppliedAt,
            tier2: s.tier2AppliedAt,
          },
          upToDateTables: [...s.upToDateTables],
        }
      },
    }
  })
}

installDebugIntrospection()
initTheme()

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
