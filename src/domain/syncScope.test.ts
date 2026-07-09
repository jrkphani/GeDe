import { describe, expect, it } from 'vitest'
import { scopeToWorkspaces, SYNCED_TABLES, UnknownSyncTableError } from './syncScope'

describe('scopeToWorkspaces (issue 058) — read-path tenancy scoping', () => {
  it('scopes a direct workspace_id-bearing table with a positional ANY($1::text[]) predicate', () => {
    const scope = scopeToWorkspaces('projects', ['ws-a', 'ws-b'])
    expect(scope.where).toBe('workspace_id = ANY($1::text[])')
    expect(scope.params).toEqual(['{"ws-a","ws-b"}'])
  })

  it('every direct workspace_id table (projects, tier1_*, tier2_tables, dimensions, contexts) uses the same simple predicate shape', () => {
    for (const table of ['projects', 'tier1_purpose', 'tier1_props', 'tier2_tables', 'dimensions', 'contexts'] as const) {
      expect(scopeToWorkspaces(table, ['ws-a']).where).toBe('workspace_id = ANY($1::text[])')
    }
  })

  it('scopes tier2_entries via its tier2_tables FK-chain ancestor (mirrors migration 0008\'s RLS policy)', () => {
    const scope = scopeToWorkspaces('tier2_entries', ['ws-a'])
    expect(scope.where).toBe('table_id IN (SELECT id FROM tier2_tables WHERE workspace_id = ANY($1::text[]))')
  })

  it('scopes parameters via its dimensions FK-chain ancestor', () => {
    const scope = scopeToWorkspaces('parameters', ['ws-a'])
    expect(scope.where).toBe('dimension_id IN (SELECT id FROM dimensions WHERE workspace_id = ANY($1::text[]))')
  })

  it('scopes bindings via its contexts FK-chain ancestor', () => {
    const scope = scopeToWorkspaces('bindings', ['ws-a'])
    expect(scope.where).toBe('context_id IN (SELECT id FROM contexts WHERE workspace_id = ANY($1::text[]))')
  })

  it('an empty workspace id set scopes to `false` — fail-closed, never an unscoped/global read', () => {
    const scope = scopeToWorkspaces('projects', [])
    expect(scope.where).toBe('false')
  })

  it('every SYNCED_TABLES entry has a real predicate — never silently unscoped', () => {
    for (const table of SYNCED_TABLES) {
      expect(() => scopeToWorkspaces(table, ['ws-a'])).not.toThrow()
      const scope = scopeToWorkspaces(table, ['ws-a'])
      expect(scope.where.length).toBeGreaterThan(0)
      expect(scope.where).not.toBe('true')
    }
  })

  it('rejects a table it does not recognize (defense in depth against a typo/forged table param)', () => {
    expect(() => scopeToWorkspaces('not_a_real_table' as never, ['ws-a'])).toThrow(UnknownSyncTableError)
  })

  it('defensively escapes quote/backslash characters in a workspace id rather than trusting the input', () => {
    const scope = scopeToWorkspaces('projects', ['ws"a\\b'])
    expect(scope.params[0]).toBe('{"ws\\"a\\\\b"}')
  })

  it('a single workspace id still produces a valid Postgres array literal (ANY over a 1-element array, not a bare "=")', () => {
    const scope = scopeToWorkspaces('projects', ['solo-ws'])
    expect(scope.params).toEqual(['{"solo-ws"}'])
  })
})

// Issue 062 — the read-path delivery fix for a fresh (not-yet-member)
// invitee: `invitations` now streams via SYNCED_TABLES, but a not-yet-member
// invitee has no matching workspace membership, so its scope must ALSO match
// by the caller's own VERIFIED email (never a client-supplied one — the
// shape-proxy handler is what enforces that boundary, see handler.test.ts).
describe('scopeToWorkspaces — invitations email-scoping (issue 062)', () => {
  it('invitations is now a real SYNCED_TABLES entry', () => {
    expect(SYNCED_TABLES).toContain('invitations')
  })

  it('given a caller email, scopes invitations to membership OR their own email, as a second positional param', () => {
    const scope = scopeToWorkspaces('invitations', ['ws-a'], 'invitee@example.com')
    expect(scope.where).toBe('(workspace_id = ANY($1::text[]) OR lower(email) = lower($2))')
    expect(scope.params).toEqual(['{"ws-a"}', 'invitee@example.com'])
  })

  it('a not-yet-member invitee (empty membership set) still gets a real, matches-by-email scope — never fail-closed to `false`', () => {
    const scope = scopeToWorkspaces('invitations', [], 'invitee@example.com')
    expect(scope.where).toBe('(workspace_id = ANY($1::text[]) OR lower(email) = lower($2))')
    expect(scope.params).toEqual(['{}', 'invitee@example.com'])
  })

  it('with no caller email, invitations falls back to the plain membership-only predicate (single param), same fail-closed-on-empty behavior as every other table', () => {
    const scoped = scopeToWorkspaces('invitations', ['ws-a'])
    expect(scoped.where).toBe('workspace_id = ANY($1::text[])')
    expect(scoped.params).toEqual(['{"ws-a"}'])

    const empty = scopeToWorkspaces('invitations', [])
    expect(empty.where).toBe('false')
  })

  it('every OTHER SYNCED_TABLES table ignores a passed-in callerEmail entirely — unchanged single-param shape', () => {
    for (const table of SYNCED_TABLES) {
      if (table === 'invitations') continue
      const withoutEmail = scopeToWorkspaces(table, ['ws-a'])
      const withEmail = scopeToWorkspaces(table, ['ws-a'], 'someone@example.com')
      expect(withEmail).toEqual(withoutEmail)
      expect(withEmail.params).toHaveLength(1)
    }
  })
})
