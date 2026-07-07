import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeApiPath } from './config'

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
