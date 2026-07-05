# ADR-0002: n-dimensional canvases

- **Status**: Accepted
- **Date**: 2026-07-04

## Context

The worked example has three dimensions (Value, Stake, Process), and early drafts hard-coded that. The method itself is general: a canvas may carry any number of dimensions, each with its own parameter set, and every parameter combination must be able to hold at least one context.

## Decision

A canvas has **n dimensions (n ≥ 2, no hard upper bound; UI optimized for 2–8) × m parameters per dimension**. A context binds exactly one parameter per dimension. Coverage is the full cross-product ∏ mᵢ and is **informational only** — capacity, never a completeness gate. Multiple contexts may share a tuple (duplicate warning, not a block).

## Consequences

- Schema is naturally n-ary (dimension count = row count); no column encodes "3".
- Coverage matrix needs axis pickers + filters beyond n = 2 grids.
- Adding/removing a dimension mutates completeness of existing contexts — governed by SPEC invariant 4 (demotion to draft, undoable, impact warnings).
