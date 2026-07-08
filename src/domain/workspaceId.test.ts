import { describe, expect, it } from 'vitest'
import { workspaceIdForSub } from './workspaceId'

// Issue 050, test-first plan item 1: "pure, deterministic, stable across
// calls, and identical when imported from the client vs the server path
// (same sub -> same id); different subs -> different ids." There is only
// ONE implementation imported by both sides (no client/server fork to
// compare against each other) — that IS the point (docs/issues/050 design
// brief: "they agree by construction").
describe('workspaceIdForSub (issue 050 — deterministic, not the repo default UUIDv7)', () => {
  it('is deterministic — the same sub always produces the same workspace id', () => {
    const sub = 'abc123-cognito-sub'
    expect(workspaceIdForSub(sub)).toBe(workspaceIdForSub(sub))
  })

  it('is stable across repeated calls in the same process', () => {
    const sub = 'stable-sub'
    const first = workspaceIdForSub(sub)
    for (let i = 0; i < 5; i++) {
      expect(workspaceIdForSub(sub)).toBe(first)
    }
  })

  it('produces different ids for different subs', () => {
    expect(workspaceIdForSub('sub-one')).not.toBe(workspaceIdForSub('sub-two'))
  })

  it('produces a well-formed UUIDv5 (version 5, RFC 4122 variant)', () => {
    const id = workspaceIdForSub('format-check-sub')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('is NOT a UUIDv7 (this repo default) — deviation is deliberate, see module header', () => {
    const id = workspaceIdForSub('not-v7-sub')
    expect(id).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })
})
