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
    { kind: 'design', projectId: 'abc', contextPath: ['c1', 'c2'], view: 'coverage' },
    { kind: 'design', projectId: 'a b', contextPath: ['c/1'], view: 'canvas' },
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
})
