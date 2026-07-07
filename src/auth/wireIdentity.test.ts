// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getIdTokenMock = vi.fn()

vi.mock('../store/auth', () => ({
  useAuthStore: {
    getState: () => ({ getIdToken: getIdTokenMock as () => Promise<string | null> }),
  },
}))

import { getAuthHeaders } from './wireIdentity'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getAuthHeaders', () => {
  it('attaches a Bearer Authorization header when a valid token is available', async () => {
    getIdTokenMock.mockResolvedValue('a-valid-jwt')
    await expect(getAuthHeaders()).resolves.toEqual({ Authorization: 'Bearer a-valid-jwt' })
  })

  it('resolves an empty header object when signed out — an unauthenticated connection, not a broken one', async () => {
    getIdTokenMock.mockResolvedValue(null)
    await expect(getAuthHeaders()).resolves.toEqual({})
  })
})
