import { useEffect } from 'react'
import { ArchitectureSurface } from './components/ArchitectureSurface'
import { DesignSurface } from './components/DesignSurface'
import { FoundationSurface } from './components/FoundationSurface'
import { Hero } from './components/Hero'
import { LoginScreen } from './components/LoginScreen'
import { ProjectsList } from './components/ProjectsList'
import { Button } from './components/ui/button'
import { AppShell } from './shell/AppShell'
import { navigate, useRoute } from './shell/router'
import { type AppRoute, type Tier } from './shell/routes'
import { ContextBarProvider } from './shell/slots'
import { useAuthStore } from './store/auth'
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

// The OAuth/PKCE authorization-code callback (SITEMAP §1) is a reserved seam
// for the Google Workspace federation fast-follow (ADR-0009) — this slice's
// sign-in is direct SRP via the SDK (src/auth/cognitoClient.ts), which never
// redirects here. Landing on this path today (a stale/external link) simply
// bounces to /login rather than showing a dead end.
function AuthCallbackRedirect() {
  useEffect(() => {
    navigate({ kind: 'login' }, { replace: true })
  }, [])
  return null
}

function Surface({ route }: { route: AppRoute }) {
  switch (route.kind) {
    case 'projects':
      return <ProjectsList onOpen={(id) => navigate({ kind: 'project', projectId: id })} />
    case 'project':
      return null // redirect handled in App effect
    case 'tier':
      if (route.tier === 'foundation') return <FoundationSurface projectId={route.projectId} />
      return <ArchitectureSurface projectId={route.projectId} />
    case 'design':
      return (
        <DesignSurface
          key={route.projectId}
          projectId={route.projectId}
          contextPath={route.contextPath}
          view={route.view}
        />
      )
    case 'welcome':
      return (
        <Hero
          onSignIn={() => navigate({ kind: 'login' })}
          onUseLocally={() => navigate({ kind: 'projects' })}
        />
      )
    case 'login':
      return <LoginScreen onSignedIn={() => navigate({ kind: 'projects' })} />
    case 'auth-callback':
      return <AuthCallbackRedirect />
    case 'not-found':
      return (
        <main className="projects">
          <section className="panel">
            <p className="placeholder">Nothing at this address.</p>
            <Button variant="command" onClick={() => navigate({ kind: 'projects' })}>
              Back to projects
            </Button>
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
    // Session hydration (issue 033) runs alongside, never before/blocking the
    // local app's own init — "session ≠ sync" (design brief). An unconfigured
    // or signed-out build settles on 'unauthenticated' without ever touching
    // the DB-readiness gate below.
    void useAuthStore.getState().hydrate()
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
