# ADR-0001: Circle canvas geometry (not ternary triangle)

- **Status**: Accepted
- **Date**: 2026-07-04

## Context

The source document (`GeDe Tavalo.numbers`) draws the 3rd Tier design as a ternary triangle where node position is meaningful. The Claude Desktop prototypes render it as a circle with one arc per dimension, where position is decorative and meaning lives in the bindings. A triangle projection only exists for exactly 3 dimensions; the method is n-ary (ADR-0002).

## Decision

The canvas is a **circle with one arc per dimension**. Node position is derived and decorative; a context's identity is its binding tuple.

## Consequences

- Works for any n ≥ 2; a triangle would have locked us to n = 3.
- Because layout is a pure function of the tree (ADR-0005), a ternary projection for the n = 3 case remains cheap to add later if wanted.
- Positions carry no data, which keeps sync payloads position-free (SPEC invariant 5).
