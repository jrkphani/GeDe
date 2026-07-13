import { afterEach, describe, expect, it, vi } from 'vitest'
import { acceptApiPath, shouldSkipReadPath, writeApiPath } from './config'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('writeApiPath (issue 048)', () => {
  it('defaults to the same-origin "/write" path — never a hardcoded full URL', () => {
    expect(writeApiPath()).toBe('/write')
  })

  it('is overridable via VITE_WRITE_API_PATH for tests/alternate environments', () => {
    vi.stubEnv('VITE_WRITE_API_PATH', '/api/write')
    expect(writeApiPath()).toBe('/api/write')
  })
})

describe('acceptApiPath (issue 080)', () => {
  it('defaults to the same-origin "/accept" path — never a hardcoded full URL', () => {
    expect(acceptApiPath()).toBe('/accept')
  })

  it('is overridable via VITE_ACCEPT_API_PATH for tests/alternate environments', () => {
    vi.stubEnv('VITE_ACCEPT_API_PATH', '/api/accept')
    expect(acceptApiPath()).toBe('/api/accept')
  })
})

// Issue 058 test-first plan item 1 — the exact 051 gate
// (`src/store/sync.ts`'s `start()` uses this directly), extracted so the
// "real URL, no injected factory" branch is testable without ever
// constructing a real Electric ShapeStream client (this repo's tests never
// do — HANDOFF: "no live Electric server is reachable in tests"; doing so
// was tried and confirmed to leak an unresolvable background long-poll into
// later tests, see src/store/sync.test.ts's own comment on this).
describe('shouldSkipReadPath (issue 051\'s crash-on-empty-URL guard, extracted for issue 058)', () => {
  it('skips when VITE_SYNC_URL is empty and no streamFactory is injected — the original 051 crash this guard prevents', () => {
    expect(shouldSkipReadPath(false)).toBe(true)
  })

  it('does NOT skip once VITE_SYNC_URL is populated, even with no streamFactory — issue 058\'s whole point: the gate naturally starts passing once a real Electric service is deployed', () => {
    vi.stubEnv('VITE_SYNC_URL', 'https://sync.example.test')
    expect(shouldSkipReadPath(false)).toBe(false)
  })

  it('does NOT skip when a streamFactory is injected, regardless of the URL — the test-seam escape hatch 051 preserved', () => {
    expect(shouldSkipReadPath(true)).toBe(false)
  })

  it('stays defensive (not deleted) for an environment where sync is enabled but the URL is still unset — 051\'s own documented risk', () => {
    vi.stubEnv('VITE_SYNC_URL', '')
    expect(shouldSkipReadPath(false)).toBe(true)
  })
})
