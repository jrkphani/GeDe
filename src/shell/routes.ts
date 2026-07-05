// SITEMAP.md §1 — the route map. URL segments use context ids (stable under
// rename); breadcrumbs display symbols. This module is pure parse/serialize;
// history binding lives in router.ts.

export type Tier = 'foundation' | 'architecture'
export type DesignView = 'canvas' | 'coverage'

export type AppRoute =
  | { kind: 'projects' }
  | { kind: 'project'; projectId: string } // redirects to the last-visited tier
  | { kind: 'tier'; projectId: string; tier: Tier }
  | { kind: 'design'; projectId: string; contextPath: string[]; view: DesignView }
  | { kind: 'not-found'; path: string }

export function parseRoute(pathname: string, search: string): AppRoute {
  const segments = pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map(decodeURIComponent)

  if (segments.length === 0) return { kind: 'projects' }
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
    const view = new URLSearchParams(search).get('view') === 'coverage' ? 'coverage' : 'canvas'
    return { kind: 'design', projectId, contextPath: segments.slice(3), view }
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
      const view = route.view === 'coverage' ? '?view=coverage' : ''
      return `/p/${enc(route.projectId)}/design${depth}${view}`
    }
    case 'not-found':
      return route.path
  }
}
