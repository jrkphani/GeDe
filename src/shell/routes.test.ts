import { describe, expect, it } from 'vitest'
import { parseRoute, serializeRoute, type AppRoute } from './routes'

describe('parseRoute', () => {
  it('parses every SITEMAP §1 route shape', () => {
    expect(parseRoute('/', '')).toEqual({ kind: 'projects' })
    expect(parseRoute('/p/abc', '')).toEqual({ kind: 'project', projectId: 'abc' })
    expect(parseRoute('/p/abc/foundation', '')).toEqual({
      kind: 'tier',
      projectId: 'abc',
      tier: 'foundation',
    })
    expect(parseRoute('/p/abc/architecture', '')).toEqual({
      kind: 'tier',
      projectId: 'abc',
      tier: 'architecture',
    })
    expect(parseRoute('/p/abc/design', '')).toEqual({
      kind: 'design',
      projectId: 'abc',
      contextPath: [],
      view: 'canvas',
    })
    expect(parseRoute('/p/abc/design/c1/c2', '')).toEqual({
      kind: 'design',
      projectId: 'abc',
      contextPath: ['c1', 'c2'],
      view: 'canvas',
    })
    expect(parseRoute('/p/abc/design/c1', '?view=coverage')).toEqual({
      kind: 'design',
      projectId: 'abc',
      contextPath: ['c1'],
      view: 'coverage',
    })
  })

  it('parses ?canvas= at depth 0 (issue 090 Phase 4c root-canvas switcher)', () => {
    expect(parseRoute('/p/abc/design', '?canvas=c9')).toEqual({
      kind: 'design',
      projectId: 'abc',
      contextPath: [],
      view: 'canvas',
      canvasId: 'c9',
    })
    expect(parseRoute('/p/abc/design', '?view=coverage&canvas=c9')).toEqual({
      kind: 'design',
      projectId: 'abc',
      contextPath: [],
      view: 'coverage',
      canvasId: 'c9',
    })
  })

  it('ignores ?canvas= at depth>0 (the context chain pins the canvas)', () => {
    expect(parseRoute('/p/abc/design/c1', '?canvas=c9')).toEqual({
      kind: 'design',
      projectId: 'abc',
      contextPath: ['c1'],
      view: 'canvas',
    })
  })

  it('parses the v2 auth on-ramp routes (issue 033, SITEMAP §1)', () => {
    expect(parseRoute('/welcome', '')).toEqual({ kind: 'welcome' })
    expect(parseRoute('/login', '')).toEqual({ kind: 'login' })
    expect(parseRoute('/auth/callback', '?code=abc')).toEqual({
      kind: 'auth-callback',
      search: '?code=abc',
    })
  })

  it('tolerates trailing slashes and decodes ids', () => {
    expect(parseRoute('/p/abc/', '')).toEqual({ kind: 'project', projectId: 'abc' })
    expect(parseRoute('/p/a%20b/design', '')).toMatchObject({ projectId: 'a b' })
  })

  it('unknown view values fall back to canvas', () => {
    expect(parseRoute('/p/abc/design', '?view=bogus')).toMatchObject({ view: 'canvas' })
  })

  it('unknown routes yield not-found', () => {
    expect(parseRoute('/x', '')).toEqual({ kind: 'not-found', path: '/x' })
    expect(parseRoute('/p', '')).toEqual({ kind: 'not-found', path: '/p' })
    expect(parseRoute('/p/abc/bogus', '')).toEqual({ kind: 'not-found', path: '/p/abc/bogus' })
  })
})

describe('serializeRoute round-trips', () => {
  const routes: AppRoute[] = [
    { kind: 'projects' },
    { kind: 'project', projectId: 'abc' },
    { kind: 'tier', projectId: 'abc', tier: 'foundation' },
    { kind: 'tier', projectId: 'abc', tier: 'architecture' },
    { kind: 'design', projectId: 'abc', contextPath: [], view: 'canvas' },
    { kind: 'design', projectId: 'abc', contextPath: [], view: 'canvas', canvasId: 'c9' },
    { kind: 'design', projectId: 'abc', contextPath: [], view: 'coverage', canvasId: 'c9' },
    { kind: 'design', projectId: 'abc', contextPath: ['c1', 'c2'], view: 'coverage' },
    { kind: 'design', projectId: 'a b', contextPath: ['c/1'], view: 'canvas' },
    { kind: 'welcome' },
    { kind: 'login' },
    { kind: 'auth-callback', search: '' },
  ]

  it('parse(serialize(route)) is identity', () => {
    for (const route of routes) {
      const url = serializeRoute(route)
      const [pathname, search = ''] = url.split('?') as [string, string?]
      expect(parseRoute(pathname, search ? `?${search}` : '')).toEqual(route)
    }
  })

  it('canvas view is the default and omitted from URLs', () => {
    expect(
      serializeRoute({ kind: 'design', projectId: 'abc', contextPath: [], view: 'canvas' }),
    ).toBe('/p/abc/design')
    expect(
      serializeRoute({ kind: 'design', projectId: 'abc', contextPath: [], view: 'coverage' }),
    ).toBe('/p/abc/design?view=coverage')
  })

  it('serializes ?canvas= at depth 0 but omits it at depth>0', () => {
    expect(
      serializeRoute({ kind: 'design', projectId: 'abc', contextPath: [], view: 'canvas', canvasId: 'c9' }),
    ).toBe('/p/abc/design?canvas=c9')
    // Depth>0: the canvas is pinned by the context chain, so `canvas` is dropped.
    expect(
      serializeRoute({ kind: 'design', projectId: 'abc', contextPath: ['c1'], view: 'canvas', canvasId: 'c9' }),
    ).toBe('/p/abc/design/c1')
  })
})
