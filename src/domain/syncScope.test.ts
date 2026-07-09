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
