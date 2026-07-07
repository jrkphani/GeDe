import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from './client'
import { getTenantContext, getTenantEmail, setTenantContext, setTenantEmail } from './tenantContext'

let db: Database

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
})

describe('setTenantContext / getTenantContext', () => {
  it('round-trips a sub through the session GUC RLS policies read', async () => {
    await setTenantContext(db, 'sub-123')
    expect(await getTenantContext(db)).toBe('sub-123')
  })

  it('resolves to null when cleared (signed out)', async () => {
    await setTenantContext(db, 'sub-123')
    await setTenantContext(db, null)
    expect(await getTenantContext(db)).toBeNull()
  })

  it('resolves to null before ever being set', async () => {
    expect(await getTenantContext(db)).toBeNull()
  })
})

// Issue 035 (ADR-0009) — the email half of the identity seam: invitations
// (migration 0009) are keyed by email, not sub, so `app_current_user_email()`
// needs its own session GUC alongside the sub's. Additive — setTenantContext's
// existing signature is untouched so no prior call site/test needed to change.
describe('setTenantEmail / getTenantEmail', () => {
  it('round-trips an email through the session GUC the invitations RLS policies read', async () => {
    await setTenantEmail(db, 'person@example.com')
    expect(await getTenantEmail(db)).toBe('person@example.com')
  })

  it('resolves to null when cleared (signed out)', async () => {
    await setTenantEmail(db, 'person@example.com')
    await setTenantEmail(db, null)
    expect(await getTenantEmail(db)).toBeNull()
  })

  it('resolves to null before ever being set', async () => {
    expect(await getTenantEmail(db)).toBeNull()
  })
})
