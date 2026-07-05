import { useEffect } from 'react'
import { DesignSurface } from './components/DesignSurface'
import { FoundationSurface } from './components/FoundationSurface'
import { ProjectsList } from './components/ProjectsList'
import { AppShell } from './shell/AppShell'
import { navigate, useRoute } from './shell/router'
import { type AppRoute, type Tier } from './shell/routes'
import { ContextBarProvider } from './shell/slots'
import { useProjectsStore } from './store/projects'

const LAST_TIER_PREFIX = 'gede-last-tier:'

function rememberTier(route: AppRoute) {
  if (route.kind === 'tier') localStorage.setItem(LAST_TIER_PREFIX + route.projectId, route.tier)
  if (route.kind === 'design') localStorage.setItem(LAST_TIER_PREFIX + route.projectId, 'design')
}

function lastTierRoute(projectId: string): AppRoute {
  const stored = localStorage.getItem(LAST_TIER_PREFIX + projectId)
  if (stored === 'design') return { kind: 'design', projectId, contextPath: [], view: 'canvas' }
  const tier: Tier = stored === 'architecture' ? 'architecture' : 'foundation'
  return { kind: 'tier', projectId, tier }
}

function Surface({ route }: { route: AppRoute }) {
  switch (route.kind) {
    case 'projects':
      return <ProjectsList onOpen={(id) => navigate({ kind: 'project', projectId: id })} />
    case 'project':
      return null // redirect handled in App effect
    case 'tier':
      if (route.tier === 'foundation') return <FoundationSurface projectId={route.projectId} />
      return (
        <main className="projects">
          <section className="panel">
            <p className="placeholder">2nd Tier · Architecture — arrives with issue 014.</p>
          </section>
        </main>
      )
    case 'design':
      return <DesignSurface projectId={route.projectId} view={route.view} />
    case 'not-found':
      return (
        <main className="projects">
          <section className="panel">
            <p className="placeholder">Nothing at this address.</p>
            <button className="row-action" onClick={() => navigate({ kind: 'projects' })}>
              Back to projects
            </button>
          </section>
        </main>
      )
  }
}

export default function App() {
  const status = useProjectsStore((s) => s.status)
  const error = useProjectsStore((s) => s.error)
  const route = useRoute()

  useEffect(() => {
    void useProjectsStore.getState().init()
  }, [])

  // /p/:id redirects to the last-visited tier; visited tiers are remembered.
  useEffect(() => {
    if (route.kind === 'project') navigate(lastTierRoute(route.projectId), { replace: true })
    else rememberTier(route)
  }, [route])

  return (
    <div className="shell-root" data-db-ready={status === 'ready'}>
      <ContextBarProvider>
        <AppShell route={route}>
          {status === 'error' && (
            <main className="projects">
              <section className="panel" role="alert">
                <p>Storage is unavailable: {error}</p>
                <p>Export/import will still work from memory this session.</p>
              </section>
            </main>
          )}
          {status === 'ready' && <Surface route={route} />}
        </AppShell>
      </ContextBarProvider>
    </div>
  )
}
