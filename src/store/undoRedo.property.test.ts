import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { openDatabase, type Database } from '../db/client'
import { createProject, listBindings, listContexts, listDimensions, listParameters } from '../db/mutations'
import { useCommandLogStore } from './commandLog'
import { setDatabase } from './database'
import { resetContextsStore, useContextsStore } from './contexts'
import { resetDimensionsStore, useDimensionsStore } from './dimensions'
import { resetParametersStore, useParametersStore } from './parameters'

// issue 006, test-first plan item 1: a random sequence of mutations across
// every entity, undone N times, must deep-equal the initial DB state; redone
// N times, must deep-equal the state right after the sequence applied. This
// is the strongest guarantee the command log offers — it validates against
// persisted rows, not just in-memory store state, so a mutation whose undo
// forgets to write through would be caught here even if the in-memory
// snapshot happened to look right.

async function snapshot(db: Database, projectId: string) {
  const dims = await listDimensions(db, projectId)
  const params: Record<string, unknown[]> = {}
  for (const d of dims) {
    params[d.id] = (await listParameters(db, d.id)).map((p) => ({
      id: p.id,
      name: p.name,
      sort: p.sort,
      parentParamId: p.parentParamId,
    }))
  }
  const contexts = await listContexts(db, projectId)
  const bindings: Record<string, Record<string, string>> = {}
  for (const c of contexts) {
    const rows = await listBindings(db, c.id)
    bindings[c.id] = Object.fromEntries(rows.map((r) => [r.dimensionId, r.parameterId]))
  }
  return {
    dimensions: dims.map((d) => ({ id: d.id, name: d.name, color: d.color, sort: d.sort })),
    params,
    contexts: contexts.map((c) => ({
      id: c.id,
      symbol: c.symbol,
      // null and '' are the same "no justification" state everywhere else in
      // the app (ContextRegister's getValue, documentedStatus) — normalize so
      // the property doesn't fail on a distinction the domain doesn't make.
      justification: c.justification ?? '',
      sort: c.sort,
    })),
    bindings,
  }
}

function pick<T>(arr: readonly T[]): T | undefined {
  return arr[Math.floor(Math.random() * arr.length)]
}

// Monotonic across the whole test run (not reset per-sample) so generated
// names/symbols are always fresh — no manual-symbol collisions to reason about.
let nameCounter = 0
function fresh(prefix: string): string {
  nameCounter += 1
  return `${prefix}-${nameCounter}`
}

// Each op reads live store state to pick a valid target, applies the store
// action (which pushes onto the real command log), and reports whether it
// actually applied — an unmet precondition (e.g. removing at the n=2 floor)
// is a skip, not a failure, so the harness only counts real commands.
const OPS: (() => Promise<boolean>)[] = [
  // add dimension — no ceiling, always applies
  async () => {
    await useDimensionsStore.getState().add()
    return true
  },
  // remove dimension — only above the n=2 floor
  async () => {
    const dims = useDimensionsStore.getState().dimensions
    if (dims.length <= 2) return false
    const target = pick(dims)
    if (!target) return false
    return (await useDimensionsStore.getState().remove(target.id)).ok
  },
  // rename dimension
  async () => {
    const target = pick(useDimensionsStore.getState().dimensions)
    if (!target) return false
    await useDimensionsStore.getState().rename(target.id, fresh('Dim'))
    return true
  },
  // reorder dimension
  async () => {
    const dims = useDimensionsStore.getState().dimensions
    if (dims.length < 2) return false
    const target = pick(dims)
    if (!target) return false
    await useDimensionsStore.getState().reorder(target.id, Math.floor(Math.random() * dims.length))
    return true
  },
  // add parameter — m is unbounded, always applies given a dimension
  async () => {
    const target = pick(useDimensionsStore.getState().dimensions)
    if (!target) return false
    const row = await useParametersStore.getState().add(target.id, fresh('Param'))
    return row !== null
  },
  // remove parameter
  async () => {
    const byDim = useParametersStore.getState().byDimension
    const dimId = pick(Object.keys(byDim).filter((id) => (byDim[id]?.length ?? 0) > 0))
    if (!dimId) return false
    const param = pick(byDim[dimId] ?? [])
    if (!param) return false
    await useParametersStore.getState().remove(dimId, param.id)
    return true
  },
  // rename parameter
  async () => {
    const byDim = useParametersStore.getState().byDimension
    const dimId = pick(Object.keys(byDim).filter((id) => (byDim[id]?.length ?? 0) > 0))
    if (!dimId) return false
    const param = pick(byDim[dimId] ?? [])
    if (!param) return false
    await useParametersStore.getState().rename(dimId, param.id, fresh('Renamed'))
    return true
  },
  // reorder parameter
  async () => {
    const byDim = useParametersStore.getState().byDimension
    const dimId = pick(Object.keys(byDim).filter((id) => (byDim[id]?.length ?? 0) >= 2))
    if (!dimId) return false
    const params = byDim[dimId] ?? []
    const param = pick(params)
    if (!param) return false
    await useParametersStore.getState().reorder(dimId, param.id, Math.floor(Math.random() * params.length))
    return true
  },
  // create context — unbounded, always applies
  async () => {
    const row = await useContextsStore.getState().create()
    return row !== null
  },
  // set symbol (always a fresh, never-colliding string)
  async () => {
    const target = pick(useContextsStore.getState().contexts)
    if (!target) return false
    return (await useContextsStore.getState().setSymbol(target.id, fresh('Sym'))).ok
  },
  // set justification
  async () => {
    const target = pick(useContextsStore.getState().contexts)
    if (!target) return false
    await useContextsStore.getState().setJustification(target.id, fresh('Justification'))
    return true
  },
  // bind
  async () => {
    const ctx = pick(useContextsStore.getState().contexts)
    const byDim = useParametersStore.getState().byDimension
    const dimId = pick(Object.keys(byDim).filter((id) => (byDim[id]?.length ?? 0) > 0))
    if (!ctx || !dimId) return false
    const param = pick(byDim[dimId] ?? [])
    if (!param) return false
    await useContextsStore.getState().bind(ctx.id, dimId, param.id)
    return true
  },
  // unbind
  async () => {
    const bindingsByContext = useContextsStore.getState().bindingsByContext
    const entries: { contextId: string; dimensionId: string }[] = []
    for (const [contextId, byDim] of Object.entries(bindingsByContext)) {
      for (const dimensionId of Object.keys(byDim)) entries.push({ contextId, dimensionId })
    }
    const target = pick(entries)
    if (!target) return false
    await useContextsStore.getState().unbind(target.contextId, target.dimensionId)
    return true
  },
]

describe('undo/redo property (issue 006)', () => {
  it('undoing N applied mutations reaches the initial state; redoing N reaches the final state', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: OPS.length - 1 }), { minLength: 8, maxLength: 24 }),
        async (opIndices) => {
          const { db } = await openDatabase('memory://')
          setDatabase(db)
          resetDimensionsStore()
          resetParametersStore()
          resetContextsStore()
          useCommandLogStore.getState().clear()

          const project = await createProject(db, { name: 'Property' })
          const projectId = project.id
          await useDimensionsStore.getState().load(projectId)
          await useDimensionsStore.getState().add()
          await useDimensionsStore.getState().add() // cross the n = 2 floor
          await useContextsStore.getState().load(projectId)
          // Seed one parameter per dimension and one bound context *before*
          // the sequence under test — otherwise every modify op (rename,
          // setSymbol, bind, ...) targets an entity whose own create() is
          // also undone within the same run, masking a broken modify-undo
          // behind the (correct) undo-of-create archiving the whole row.
          const seededDims = useDimensionsStore.getState().dimensions
          for (const d of seededDims) await useParametersStore.getState().add(d.id, fresh('Seed'))
          const seededCtx = await useContextsStore.getState().create()
          if (seededCtx) {
            for (const d of seededDims) {
              const param = useParametersStore.getState().byDimension[d.id]?.[0]
              if (param) await useContextsStore.getState().bind(seededCtx.id, d.id, param.id)
            }
          }
          useCommandLogStore.getState().clear() // setup itself isn't part of the sequence under test

          const initial = await snapshot(db, projectId)

          let applied = 0
          for (const idx of opIndices) {
            const op = OPS[idx]
            if (op && (await op())) applied++
          }
          const final = await snapshot(db, projectId)

          for (let i = 0; i < applied; i++) await useCommandLogStore.getState().undo()
          expect(await snapshot(db, projectId)).toEqual(initial)

          for (let i = 0; i < applied; i++) await useCommandLogStore.getState().redo()
          expect(await snapshot(db, projectId)).toEqual(final)
        },
      ),
      { numRuns: 40 },
    )
  }, 60_000)
})
