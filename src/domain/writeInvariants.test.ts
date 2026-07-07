import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client'
import { addDimension, createProject, DimensionFloorError, listDimensions, removeDimension } from '../db/mutations'
import {
  MIN_DIMENSIONS,
  violatesBindingUniqueness,
  violatesDimensionFloor,
  violatesReferentialIntegrity,
} from './writeInvariants'

describe('violatesDimensionFloor', () => {
  it('is true at and below the floor, false above it', () => {
    expect(violatesDimensionFloor(0)).toBe(true)
    expect(violatesDimensionFloor(1)).toBe(true)
    expect(violatesDimensionFloor(MIN_DIMENSIONS)).toBe(true)
    expect(violatesDimensionFloor(MIN_DIMENSIONS + 1)).toBe(false)
    expect(violatesDimensionFloor(10)).toBe(false)
  })

  it('property: agrees with a reference n <= 2 predicate for any live count', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50 }), (n) => {
        expect(violatesDimensionFloor(n)).toBe(n <= 2)
      }),
    )
  })

  // The parity test issue 043 explicitly asks for: "property-test against
  // the client-side rules so client and server agree" (implementation
  // notes). This runs the REAL client mutation (src/db/mutations.ts,
  // against an in-memory PGlite) and asserts it throws DimensionFloorError
  // iff the shared predicate says the floor is violated — proving the two
  // layers can't drift because they now share one function, not two.
  it('parity: the client removeDimension() throws iff violatesDimensionFloor() says so', async () => {
    const { db } = await openDatabase('memory://')
    const project = await createProject(db, { name: 'Parity' })

    // Start with exactly MIN_DIMENSIONS + 2 dimensions, then remove down to
    // the floor, checking agreement at every step.
    const dims = []
    for (let i = 0; i < MIN_DIMENSIONS + 2; i++) {
      dims.push(await addDimension(db, project.id))
    }

    for (const dim of dims) {
      const before = (await listDimensions(db, project.id)).length
      const expectViolation = violatesDimensionFloor(before)
      if (expectViolation) {
        await expect(removeDimension(db, project.id, dim.id)).rejects.toBeInstanceOf(DimensionFloorError)
      } else {
        await expect(removeDimension(db, project.id, dim.id)).resolves.toBeDefined()
      }
    }
  })
})

describe('violatesBindingUniqueness', () => {
  it('is false when no other binding occupies the (context, dimension) pair', () => {
    expect(violatesBindingUniqueness(0)).toBe(false)
  })

  it('is true when a different binding already occupies the pair', () => {
    expect(violatesBindingUniqueness(1)).toBe(true)
  })
})

describe('violatesReferentialIntegrity', () => {
  it('is false when every referenced id resolved', () => {
    expect(violatesReferentialIntegrity([])).toBe(false)
  })

  it('is true when any referenced id failed to resolve', () => {
    expect(violatesReferentialIntegrity(['missing-id'])).toBe(true)
  })
})
