import { useEffect } from 'react'
import { HeroLanding } from './components/HeroLanding'
import { ProjectsList } from './components/ProjectsList'
import { WorkspaceSurface } from './components/WorkspaceSurface'
import { Button } from './components/ui/button'
import { AppShell } from './shell/AppShell'
import { laneForRoute, scrollToLane } from './shell/laneTarget'
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
    // Issue 089 D2 Phase 1 — project / tier / design all mount the unified
    // workspace (three tier lanes on one page). The route grammar is unchanged
    // (SITEMAP §1): the URL identity, the `/p/:id`→lastTierRoute redirect
    // (App effect below), and Design's contextPath/view/canvasId all persist —
    // WorkspaceSurface only changes WHAT the route mounts, not how it parses.
    case 'project':
    case 'tier':
    case 'design':
      return <WorkspaceSurface route={route} />
    // Issue 064: /welcome and /login both render the same hero/landing
    // surface — product brief + the 3-mode auth card in one polished page.
    // It is the canonical signed-out destination and the sign-out redirect
    // target (issue 063).
    case 'welcome':
    case 'login':
      return (
        <HeroLanding
          onSignedIn={() => navigate({ kind: 'projects' })}
          onUseLocally={() => navigate({ kind: 'projects' })}
        />
      )
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

  // Issue 089 D2 P2 — the retained tier/design routes are scroll-to-lane
  // deep-links: whenever the active route resolves to a lane, bring that
  // `.workspace__lane--*` section into view. Runs after WorkspaceSurface commits
  // (useEffect fires post-DOM), so the lane element exists; scrollToLane also
  // guards the not-yet-mounted case. Gated + keyed on `status` so a COLD deep
  // link (`/p/:id/design` loaded while the DB is still hydrating, when no lanes
  // are mounted yet) still scrolls once `status` flips to 'ready' and the lanes
  // paint. Covers every route change — tab clicks, ⌘1/2/3, back/forward, and the
  // `project`→tier redirect above (which lands here as a concrete tier route).
  useEffect(() => {
    if (status !== 'ready') return
    scrollToLane(laneForRoute(route))
  }, [route, status])

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
