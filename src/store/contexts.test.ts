import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client'
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
})
