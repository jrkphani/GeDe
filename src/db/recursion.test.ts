import { describe, expect, it } from 'vitest'
import { openDatabase } from './client'
import {
  addDimension,
  addParameter,
  bindParameter,
  createContext,
  createProject,
  listContexts,
  listDimensions,
  listParameters,
  openChildCanvas,
  revertStaleRebind,
  setContextSymbol,
  archiveContext,
} from './mutations'

function must<T>(value: T | null | undefined, label = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${label} to be defined`)
  return value
}

// A complete root context α on a 2-dimension canvas (Value/Stake), each with
// two parameters, α bound to (Comfort, Users). This mirrors the Numbers
// worked example's drill target at reduced size.
async function projectWithBoundAlpha() {
  const { db } = await openDatabase('memory://')
  const project = await createProject(db, { name: 'Tavalo' })
  const projectId = project.id
  const value = await addDimension(db, projectId)
  const stake = await addDimension(db, projectId)
  const comfort = await addParameter(db, value.id, 'Comfort')
  const mobility = await addParameter(db, value.id, 'Mobility')
  const users = await addParameter(db, stake.id, 'Users')
  const buyers = await addParameter(db, stake.id, 'Buyers')
  const alpha = await createContext(db, projectId)
  await bindParameter(db, alpha.id, value.id, comfort.id)
  await bindParameter(db, alpha.id, stake.id, users.id)
  return { db, projectId, value, stake, comfort, mobility, users, buyers, alpha }
}

describe('openChildCanvas — seeding (test-first plan 1)', () => {
  it('first drill-in creates exactly one child dimension per parent binding', async () => {
    const { db, alpha, comfort, users } = await projectWithBoundAlpha()
    const { dimensions, stale } = await openChildCanvas(db, alpha.id)

    expect(dimensions).toHaveLength(2)
    expect(stale).toHaveLength(0)
    // Each child dimension is scoped to α's canvas and records its source param.
    expect(dimensions.every((d) => d.contextId === alpha.id)).toBe(true)
    expect(new Set(dimensions.map((d) => d.sourceParamId))).toEqual(new Set([comfort.id, users.id]))
    // Named after the bound parameters (design brief lineage line).
    expect(new Set(dimensions.map((d) => d.name))).toEqual(new Set(['Comfort', 'Users']))
    // In the parent's dimension sort order.
    expect(dimensions.map((d) => d.sort)).toEqual([0, 1])
    expect(dimensions[0]?.sourceParamId).toBe(comfort.id)
    expect(dimensions[1]?.sourceParamId).toBe(users.id)
  })

  it('is idempotent — a second open never duplicates child dimensions', async () => {
    const { db, alpha } = await projectWithBoundAlpha()
    const first = await openChildCanvas(db, alpha.id)
    const second = await openChildCanvas(db, alpha.id)
    expect(second.dimensions.map((d) => d.id)).toEqual(first.dimensions.map((d) => d.id))
    expect(await listDimensions(db, alpha.projectId, second.canvasId)).toHaveLength(2)
  })

  it('child-dimension parameters are the source parameter’s sub-parameters (dimension-scoped)', async () => {
    const { db, alpha, comfort } = await projectWithBoundAlpha()
    const { dimensions } = await openChildCanvas(db, alpha.id)
    const comfortDim = must(dimensions.find((d) => d.sourceParamId === comfort.id))
    // Freshly seeded: no sub-parameters yet (first-open seeding prompt case).
    expect(await listParameters(db, comfortDim.id)).toHaveLength(0)
    // Sub-parameters created against the child dimension carry the lineage.
    const sub = await addParameter(db, comfortDim.id, 'Warm', comfort.id)
    expect(sub.parentParamId).toBe(comfort.id)
    expect(await listParameters(db, comfortDim.id)).toHaveLength(1)
    // They do NOT leak into the parent (root) dimension's parameter list.
    expect((await listParameters(db, comfort.dimensionId)).map((p) => p.name)).toEqual(['Comfort', 'Mobility'])
  })
})

describe('openChildCanvas — stale parent re-bind (test-first plan 1)', () => {
  it('parent re-bind makes the child dimension follow the new parameter and retires its sub-bindings', async () => {
    const { db, alpha, stake, users, buyers } = await projectWithBoundAlpha()
    // Open child, add a sub-parameter under the Users child dimension, and give
    // a child context a sub-binding on it.
    const { dimensions } = await openChildCanvas(db, alpha.id)
    const usersDim = must(dimensions.find((d) => d.sourceParamId === users.id))
    const inner = await addParameter(db, usersDim.id, 'Inner Circle', users.id)
    const child = await createContext(db, alpha.projectId, alpha.id)
    await bindParameter(db, child.id, usersDim.id, inner.id)

    // Parent re-binds Stake: Users → Buyers.
    await bindParameter(db, alpha.id, stake.id, buyers.id)

    const { dimensions: after, stale } = await openChildCanvas(db, alpha.id)
    // No duplicate dimension — the same child dimension row followed the param.
    expect(after).toHaveLength(2)
    const followed = must(after.find((d) => d.id === usersDim.id))
    expect(followed.sourceParamId).toBe(buyers.id)
    expect(followed.name).toBe('Buyers')
    // The stale event reports the retirement for the banner.
    expect(stale).toHaveLength(1)
    expect(stale[0]?.childDimensionId).toBe(usersDim.id)
    expect(stale[0]?.fromName).toBe('Users')
    expect(stale[0]?.toName).toBe('Buyers')
    expect(stale[0]?.retiredBindings).toHaveLength(1)
    // The now-invalid sub-binding was hard-deleted.
    const childBindings = await import('./mutations').then((m) => m.listBindings(db, child.id))
    expect(childBindings).toHaveLength(0)
  })

  it('revertStaleRebind restores the source parameter and the retired sub-bindings', async () => {
    const { db, alpha, stake, users, buyers } = await projectWithBoundAlpha()
    const { dimensions } = await openChildCanvas(db, alpha.id)
    const usersDim = must(dimensions.find((d) => d.sourceParamId === users.id))
    const inner = await addParameter(db, usersDim.id, 'Inner Circle', users.id)
    const child = await createContext(db, alpha.projectId, alpha.id)
    await bindParameter(db, child.id, usersDim.id, inner.id)
    await bindParameter(db, alpha.id, stake.id, buyers.id)
    const { stale, canvasId: alphaCanvasId } = await openChildCanvas(db, alpha.id)

    await revertStaleRebind(db, must(stale[0]))

    const restored = must(
      (await listDimensions(db, alpha.projectId, alphaCanvasId)).find((d) => d.id === usersDim.id),
    )
    expect(restored.sourceParamId).toBe(users.id)
    expect(restored.name).toBe('Users')
    const childBindings = await import('./mutations').then((m) => m.listBindings(db, child.id))
    expect(childBindings.map((b) => b.parameterId)).toEqual([inner.id])
  })
})

describe('child context lineage (test-first plan 2)', () => {
  it('α’s children are α1…αk, and deleting α2 does not renumber α3', async () => {
    const { db, alpha } = await projectWithBoundAlpha()
    const parent = alpha.id
    const a1 = await createContext(db, alpha.projectId, parent)
    const a2 = await createContext(db, alpha.projectId, parent)
    const a3 = await createContext(db, alpha.projectId, parent)
    expect([a1.symbol, a2.symbol, a3.symbol]).toEqual(['α1', 'α2', 'α3'])

    await archiveContext(db, a2.id)
    // Identity stability: deleting α2 never renumbers the surviving children —
    // α3 is still α3 (its row is untouched). The freed α2 slot is later
    // re-fillable (same gap-fill semantics as root symbols) but α3 is never
    // shifted down onto it.
    const next = await createContext(db, alpha.projectId, parent)
    expect(a1.symbol).toBe('α1')
    expect(a3.symbol).toBe('α3')
    // a1.canvasId is α's child canvas — all of α's children share it.
    expect((await listContexts(db, alpha.projectId, a1.canvasId)).find((c) => c.id === a3.id)?.symbol).toBe(
      'α3',
    )
    expect(next.symbol).toBe('α2') // gap-fills the freed slot, does not touch α3
  })

  it('child symbols are scoped per canvas — β1 and α1 coexist', async () => {
    const { db, projectId, alpha } = await projectWithBoundAlpha()
    const beta = await createContext(db, projectId)
    const a1 = await createContext(db, projectId, alpha.id)
    const b1 = await createContext(db, projectId, beta.id)
    expect(a1.symbol).toBe('α1')
    expect(b1.symbol).toBe('β1')
    // Listing α's canvas returns only α's children.
    expect((await listContexts(db, projectId, a1.canvasId)).map((c) => c.symbol)).toEqual(['α1'])
    expect((await listContexts(db, projectId, b1.canvasId)).map((c) => c.symbol)).toEqual(['β1'])
    // A per-canvas symbol collision on a child canvas is still rejected.
    await expect(setContextSymbol(db, projectId, b1.id, 'β1')).resolves.toBeDefined()
  })
})

describe('recursion depth — per-canvas scoping (test-first plan 3)', () => {
  it('a depth-chain keeps dimensions and contexts scoped with no cross-level leakage', async () => {
    const { db, projectId, alpha, value, stake, comfort, users } = await projectWithBoundAlpha()
    // Build α → α1 (bound) → α1a (child) three levels deep.
    const { dimensions: l1, canvasId: alphaCanvasId } = await openChildCanvas(db, alpha.id)
    const comfortDim = must(l1.find((d) => d.sourceParamId === comfort.id))
    const usersDim = must(l1.find((d) => d.sourceParamId === users.id))
    const warm = await addParameter(db, comfortDim.id, 'Warm', comfort.id)
    const inner = await addParameter(db, usersDim.id, 'Inner', users.id)
    const a1 = await createContext(db, projectId, alpha.id)
    await bindParameter(db, a1.id, comfortDim.id, warm.id)
    await bindParameter(db, a1.id, usersDim.id, inner.id)

    const { dimensions: l2, canvasId: a1CanvasId } = await openChildCanvas(db, a1.id)
    expect(l2).toHaveLength(2)
    expect(new Set(l2.map((d) => d.sourceParamId))).toEqual(new Set([warm.id, inner.id]))

    // Each level's dimension list is exactly its own — no leakage up or down.
    expect((await listDimensions(db, projectId, null)).map((d) => d.id)).toEqual([value.id, stake.id])
    expect((await listDimensions(db, projectId, alphaCanvasId)).map((d) => d.id).sort()).toEqual(
      [comfortDim.id, usersDim.id].sort(),
    )
    expect((await listDimensions(db, projectId, a1CanvasId)).map((d) => d.id).sort()).toEqual(
      l2.map((d) => d.id).sort(),
    )
    // Root canvas contexts don't include the deep children.
    expect((await listContexts(db, projectId, null)).map((c) => c.id)).toEqual([alpha.id])
  })
})
