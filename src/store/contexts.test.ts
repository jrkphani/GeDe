import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../db/client'
import * as mutations from '../db/mutations'
import { addDimension, addParameter, createProject, listContexts } from '../db/mutations'
import { setDatabase } from './database'
import { useCommandLogStore } from './commandLog'
import { resetContextsStore, useContextsStore } from './contexts'

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let projectId: string
let valueId: string
let stakeId: string
let comfortId: string
let usersId: string

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetContextsStore()
  useCommandLogStore.getState().clear()
  const project = await createProject(db, { name: 'Tavalo' })
  projectId = project.id
  const value = await addDimension(db, projectId)
  const stake = await addDimension(db, projectId)
  valueId = value.id
  stakeId = stake.id
  comfortId = (await addParameter(db, value.id, 'Comfort')).id
  usersId = (await addParameter(db, stake.id, 'Users')).id
  await useContextsStore.getState().load(projectId)
})

describe('contexts store — command log (issue 006)', () => {
  it('undo of create archives it (persisted too); redo restores the same id and symbol', async () => {
    const ctx = await useContextsStore.getState().create()
    const id = (ctx as { id: string }).id

    await useCommandLogStore.getState().undo()
    expect(useContextsStore.getState().contexts).toEqual([])
    expect(await listContexts(db, projectId)).toEqual([])

    await useCommandLogStore.getState().redo()
    expect(useContextsStore.getState().contexts.map((c) => c.id)).toEqual([id])
    expect(useContextsStore.getState().contexts[0]?.symbol).toBe('α')
  })

  it('undo of setSymbol restores the previous symbol; redo re-applies the new one', async () => {
    const ctx = await useContextsStore.getState().create()
    const id = (ctx as { id: string }).id
    await useContextsStore.getState().setSymbol(id, 'ω')

    await useCommandLogStore.getState().undo()
    expect(useContextsStore.getState().contexts[0]?.symbol).toBe('α')

    await useCommandLogStore.getState().redo()
    expect(useContextsStore.getState().contexts[0]?.symbol).toBe('ω')
  })

  it('undo of setJustification restores the previous text', async () => {
    const ctx = await useContextsStore.getState().create()
    const id = (ctx as { id: string }).id
    await useContextsStore.getState().setJustification(id, 'first')
    await useContextsStore.getState().setJustification(id, 'second')

    await useCommandLogStore.getState().undo()
    expect(useContextsStore.getState().contexts[0]?.justification).toBe('first')

    await useCommandLogStore.getState().redo()
    expect(useContextsStore.getState().contexts[0]?.justification).toBe('second')
  })

  it('undo of bind unbinds (or restores the previous parameter); redo re-binds', async () => {
    const ctx = await useContextsStore.getState().create()
    const id = (ctx as { id: string }).id
    await useContextsStore.getState().bind(id, valueId, comfortId)

    await useCommandLogStore.getState().undo()
    expect(useContextsStore.getState().bindingsByContext[id]?.[valueId]).toBeUndefined()

    await useCommandLogStore.getState().redo()
    expect(useContextsStore.getState().bindingsByContext[id]?.[valueId]).toBe(comfortId)
  })

  it('rebinding then undo restores the prior parameter, not an unbind', async () => {
    const ctx = await useContextsStore.getState().create()
    const id = (ctx as { id: string }).id
    await useContextsStore.getState().bind(id, valueId, comfortId)
    const otherComfort = await addParameter(db, valueId, 'Mobility')
    await useContextsStore.getState().bind(id, valueId, otherComfort.id)

    await useCommandLogStore.getState().undo()
    expect(useContextsStore.getState().bindingsByContext[id]?.[valueId]).toBe(comfortId)
  })

  it('undo of unbind restores the binding; redo unbinds again', async () => {
    const ctx = await useContextsStore.getState().create()
    const id = (ctx as { id: string }).id
    await useContextsStore.getState().bind(id, valueId, comfortId)
    await useContextsStore.getState().unbind(id, valueId)
    expect(useContextsStore.getState().bindingsByContext[id]?.[valueId]).toBeUndefined()

    await useCommandLogStore.getState().undo()
    expect(useContextsStore.getState().bindingsByContext[id]?.[valueId]).toBe(comfortId)

    await useCommandLogStore.getState().redo()
    expect(useContextsStore.getState().bindingsByContext[id]?.[valueId]).toBeUndefined()
  })

  it('batches create + first justification into a single undo step', async () => {
    let id = ''
    await useCommandLogStore.getState().batch('create context', async () => {
      const ctx = await useContextsStore.getState().create()
      id = (ctx as { id: string }).id
      await useContextsStore.getState().setJustification(id, 'Stake reflects the primary beneficiaries')
    })

    expect(useCommandLogStore.getState().past).toHaveLength(1)
    expect(useContextsStore.getState().contexts[0]?.justification).toBe(
      'Stake reflects the primary beneficiaries',
    )

    await useCommandLogStore.getState().undo()
    expect(useContextsStore.getState().contexts).toEqual([])
    expect(await listContexts(db, projectId)).toEqual([])

    await useCommandLogStore.getState().redo()
    expect(useContextsStore.getState().contexts.map((c) => c.id)).toEqual([id])
    expect(useContextsStore.getState().contexts[0]?.justification).toBe(
      'Stake reflects the primary beneficiaries',
    )
  })

  it('undo/redo bind also touches usersId/stakeId (sanity for the second dimension)', async () => {
    const ctx = await useContextsStore.getState().create()
    const id = (ctx as { id: string }).id
    await useContextsStore.getState().bind(id, stakeId, usersId)
    await useCommandLogStore.getState().undo()
    expect(useContextsStore.getState().bindingsByContext[id]?.[stakeId]).toBeUndefined()
  })

  // Root-caused a real CI-only e2e failure (undo-redo.spec.ts, issue 007
  // cleanup) via a Playwright trace: the register's first-mount load(projectId)
  // (fired by ContextRegister's own effect) can still be in flight when a
  // context is created moments later; if that stale, pre-create SELECT
  // resolves *after* create()'s own state update, it silently overwrites the
  // just-created context out of the store (no error — the DB row is fine,
  // only in-memory state is wrong). Mirrors the exact race parameters.ts
  // already guards against with a generation counter (issue 004 fix).
  it('a slow initial load() never overwrites a context created while it was in flight', async () => {
    const originalListContexts = mutations.listContexts
    let releaseSlowLoad: (() => void) | undefined
    const slow = new Promise<void>((resolve) => {
      releaseSlowLoad = resolve
    })
    let callIndex = 0
    const spy = vi.spyOn(mutations, 'listContexts').mockImplementation(async (db, pid) => {
      const myIndex = callIndex
      callIndex += 1
      const rows = await originalListContexts(db, pid) // real read, captured now
      if (myIndex === 0) await slow // withhold only load()'s own (first) call
      return rows
    })

    const loadPromise = useContextsStore.getState().load(projectId) // call #0 — reads empty, then hangs
    const created = await useContextsStore.getState().create() // calls #1 (symbol lookup) + #2 (post-insert list) — both proceed normally
    expect(useContextsStore.getState().contexts.map((c) => c.id)).toEqual([(created as { id: string }).id])

    releaseSlowLoad?.() // load()'s stale (pre-create) result now resolves
    await loadPromise

    expect(useContextsStore.getState().contexts.map((c) => c.id)).toEqual([(created as { id: string }).id])
    spy.mockRestore()
  })
})
