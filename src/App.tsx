import { lazy, Suspense, useEffect } from 'react'
import { HeroLanding } from './components/HeroLanding'
import { ProjectsList } from './components/ProjectsList'
import { WorkspaceSurface } from './components/WorkspaceSurface'
// Eager, side-effect-only import: registers the ⌘1/2/3 pan-to-lane capture
// listener at module-eval time (BEFORE AppShell's mount-effect listener, so the
// canvas interceptor wins the capture race). This module is `@xyflow/react`-free,
// so importing it eagerly costs the prod bundle nothing — no React Flow JS, no
// CSS. See src/components/d3CanvasNav.ts.
import './components/d3CanvasNav'
import { Button } from './components/ui/button'
import { AppShell } from './shell/AppShell'
import { laneForRoute, scrollToLane } from './shell/laneTarget'
import { navigate, useRoute } from './shell/router'
import { type AppRoute, type Tier } from './shell/routes'
import { ContextBarProvider } from './shell/slots'
import { useAuthStore } from './store/auth'
import { useCanvasModeStore } from './store/canvasMode'
import { useProjectsStore } from './store/projects'

const LAST_TIER_PREFIX = 'gede-last-tier:'

// 089-D3 — the React Flow canvas is the ONLY thing that pulls in `@xyflow/react`
// (JS + its ~18.6 KB stylesheet). `React.lazy` puts it in its own async chunk so
// a static `import` never drags React Flow into the main bundle; combined with
// the `import.meta.env.DEV` gate on `canvasMode`'s `canvasEnabled` (store/
// canvasMode.ts), a production build folds the mount site away and never
// imports this chunk — so neither the JS nor the CSS ships to prod users. The
// canvasEnabled read is a store lookup (not a URL read) so the canvas survives
// an in-app navigate that drops `?d3rf`. The lightweight ⌘1/2/3 interceptor is imported
// eagerly above instead (d3CanvasNav), preserving the register-first ordering.
const WorkspaceCanvas = lazy(() =>
  import('./components/WorkspaceCanvas').then((m) => ({ default: m.WorkspaceCanvas })),
)

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
  // 089-D3 graduation P0 — the dev-only canvas opt-in now lives in a store,
  // seeded ONCE from the initial `?d3rf` (store/canvasMode.ts). Reading the
  // store instead of `window.location.search` means an in-app navigate() that
  // drops `?d3rf` (a tab click, a drill-in, the `v` toggle) no longer unmounts
  // the canvas mid-flow — a prerequisite for the satellite phases, which all
  // navigate. Still DEV-gated + folds to a constant `false` in prod builds.
  const canvasEnabled = useCanvasModeStore((s) => s.canvasEnabled)
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
      // 089-D3 P1 — dev-only `?d3rf` flag swaps in the React Flow canvas; OFF by
      // default and dead in prod builds (canvasEnabled folds to `false`), so
      // normal app behavior is unchanged. The canvas is `React.lazy` (its own
      // async chunk), so it's wrapped in <Suspense> while the chunk loads.
      return canvasEnabled ? (
        <Suspense fallback={null}>
          <WorkspaceCanvas route={route} />
        </Suspense>
      ) : (
        <WorkspaceSurface route={route} />
      )
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
