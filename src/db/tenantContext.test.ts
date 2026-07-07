import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from './client'
import { getTenantContext, setTenantContext } from './tenantContext'

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
