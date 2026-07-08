import { describe, expect, it } from 'vitest'
import { NAMESPACE_DNS, uuidv5 } from './uuidv5'

// RFC 4122 has no worked example in its own text, but `uuidv5(NAMESPACE_DNS,
// 'python.org')` is the widely-cited cross-implementation test vector (it's
// literally the doctest in Python's own `uuid` stdlib module, and every other
// language's uuid library agrees on it) — the standard way to prove a
// from-scratch SHA-1-based UUIDv5 implementation is bit-for-bit correct
// without vendoring a reference implementation as a dependency.
describe('uuidv5 (RFC 4122 §4.3, SHA-1-based)', () => {
  it('matches the well-known NAMESPACE_DNS + "python.org" cross-implementation vector', () => {
    expect(uuidv5(NAMESPACE_DNS, 'python.org')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d')
  })

  it('is deterministic — same namespace + name always produces the same id', () => {
    const a = uuidv5(NAMESPACE_DNS, 'repeat-me')
    const b = uuidv5(NAMESPACE_DNS, 'repeat-me')
    expect(a).toBe(b)
  })

  it('produces different ids for different names under the same namespace', () => {
    expect(uuidv5(NAMESPACE_DNS, 'alice')).not.toBe(uuidv5(NAMESPACE_DNS, 'bob'))
  })

  it('produces different ids for the same name under different namespaces', () => {
    const otherNamespace = '6ba7b811-9dad-11d1-80b4-00c04fd430c8' // NAMESPACE_URL
    expect(uuidv5(NAMESPACE_DNS, 'same-name')).not.toBe(uuidv5(otherNamespace, 'same-name'))
  })

  it('always emits the version-5 and RFC-4122-variant nibbles', () => {
    const id = uuidv5(NAMESPACE_DNS, 'version-check')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
