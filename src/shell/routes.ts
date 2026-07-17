// SITEMAP.md §1 — the route map. URL segments use context ids (stable under
// rename); breadcrumbs display symbols. This module is pure parse/serialize;
// history binding lives in router.ts.

export type Tier = 'foundation' | 'architecture'
export type DesignView = 'canvas' | 'coverage'

export type AppRoute =
  | { kind: 'projects' }
  | { kind: 'project'; projectId: string } // redirects to the last-visited tier
  | { kind: 'tier'; projectId: string; tier: Tier }
  // Issue 090 Phase 4c — `canvasId` selects among a project's N root canvases
  // (the switcher). Only meaningful at depth 0 (contextPath empty); at depth>0
  // the open canvas is fully determined by the context chain, so it is neither
  // parsed nor serialized there.
  | {
      kind: 'design'
      projectId: string
      contextPath: string[]
      view: DesignView
      // `| undefined` (not just `?`) so callers may pass an explicit
      // `canvasId: maybeUndefined` under exactOptionalPropertyTypes.
      canvasId?: string | undefined
    }
  // v2 (issue 033, ADR-0009) — the hero/login on-ramp. Never gates `/` or any
  // project route; the account-free local app is reachable regardless.
  | { kind: 'welcome' }
  | { kind: 'login' }
  | { kind: 'auth-callback'; search: string }
  | { kind: 'not-found'; path: string }

export function parseRoute(pathname: string, search: string): AppRoute {
  const segments = pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map(decodeURIComponent)

  if (segments.length === 0) return { kind: 'projects' }
  if (segments.length === 1 && segments[0] === 'welcome') return { kind: 'welcome' }
  if (segments.length === 1 && segments[0] === 'login') return { kind: 'login' }
  if (segments.length === 2 && segments[0] === 'auth' && segments[1] === 'callback') {
    return { kind: 'auth-callback', search }
  }
  if (segments[0] !== 'p' || segments.length < 2) return { kind: 'not-found', path: pathname }

  const projectId = segments[1] as string
  if (segments.length === 2) return { kind: 'project', projectId }

  const section = segments[2]
  if (section === 'foundation' || section === 'architecture') {
    if (segments.length > 3) return { kind: 'not-found', path: pathname }
    return { kind: 'tier', projectId, tier: section }
  }
  if (section === 'design') {
    // Unknown view values degrade to the canvas default rather than 404ing —
    // the path still identifies a real canvas.
    const params = new URLSearchParams(search)
    const view = params.get('view') === 'coverage' ? 'coverage' : 'canvas'
    const contextPath = segments.slice(3)
    // `?canvas=` is only meaningful at depth 0 — a deeper path already pins the
    // canvas via its context chain, so ignore the param there.
    const canvasParam = contextPath.length === 0 ? params.get('canvas') : null
    return {
      kind: 'design',
      projectId,
      contextPath,
      view,
      ...(canvasParam ? { canvasId: canvasParam } : {}),
    }
  }
  return { kind: 'not-found', path: pathname }
}

export function serializeRoute(route: AppRoute): string {
  const enc = encodeURIComponent
  switch (route.kind) {
    case 'projects':
      return '/'
    case 'project':
      return `/p/${enc(route.projectId)}`
    case 'tier':
      return `/p/${enc(route.projectId)}/${route.tier}`
    case 'design': {
      const depth = route.contextPath.map((c) => `/${enc(c)}`).join('')
      const params = new URLSearchParams()
      if (route.view === 'coverage') params.set('view', 'coverage')
      // Serialize `canvas` only at depth 0 (contextPath empty) — deeper routes
      // derive the canvas from the context chain, so the param is redundant and
      // omitted to keep the URL identity stable across a drill-in.
      if (route.canvasId && route.contextPath.length === 0) params.set('canvas', route.canvasId)
      const query = params.toString()
      return `/p/${enc(route.projectId)}/design${depth}${query ? `?${query}` : ''}`
    }
    case 'welcome':
      return '/welcome'
    case 'login':
      return '/login'
    case 'auth-callback':
      return `/auth/callback${route.search}`
    case 'not-found':
      return route.path
  }
}
