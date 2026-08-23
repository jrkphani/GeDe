import { describe, expect, it } from 'vitest'
import { openDatabase } from './client'
import {
  addTier2Entry,
  addTier2Table,
  archiveDesignProseReference,
  createContext,
  createDesignProseReference,
  createProject,
  getContextsByIds,
  listDesignProseReferences,
  restoreDesignProseReference,
  setContextJustificationWithReferences,
} from './mutations'

async function projectWithContext() {
  const { db } = await openDatabase('memory://')
  const project = await createProject(db, { name: 'Tavalo' })
  const ctx = await createContext(db, project.id)
  const table = await addTier2Table(db, project.id, 'Architecture')
  const entryA = await addTier2Entry(db, table.id, null, 'Entry A')
  const entryB = await addTier2Entry(db, table.id, null, 'Entry B')
  return { db, projectId: project.id, contextId: ctx.id, entryA: entryA.id, entryB: entryB.id }
}

describe('design prose reference mutation-layer functions (Phase 3)', () => {
  it('create/list/archive/restore mirror the contexts create/archive/restore shape', async () => {
    const { db, contextId, entryA } = await projectWithContext()
    const project = await createProject(db, { name: 'Other' })
    const workspaceId = project.workspaceId

    const row = await createDesignProseReference(db, contextId, entryA, workspaceId)
    expect(row.contextId).toBe(contextId)
    expect(row.sourceEntryId).toBe(entryA)
    expect(row.deletedAt).toBeNull()

    expect(await listDesignProseReferences(db, contextId)).toHaveLength(1)

    const archived = await archiveDesignProseReference(db, row.id)
    expect(archived.deletedAt).not.toBeNull()
    expect(await listDesignProseReferences(db, contextId)).toHaveLength(0)

    const restored = await restoreDesignProseReference(db, row.id)
    expect(restored.deletedAt).toBeNull()
    expect(await listDesignProseReferences(db, contextId)).toHaveLength(1)
  })
})

describe('setContextJustificationWithReferences — atomic commit (Phase 3)', () => {
  it('updates the justification text and reports every touched row', async () => {
    const { db, contextId, entryA } = await projectWithContext()
    const result = await setContextJustificationWithReferences(db, contextId, 'prose v1', [entryA])
    expect(result.context.justification).toBe('prose v1')
    expect(result.createdReferences).toHaveLength(1)
    expect(result.createdReferences[0]?.sourceEntryId).toBe(entryA)
    expect(result.revivedReferences).toHaveLength(0)
    expect(result.tombstonedReferences).toHaveLength(0)

    const rows = await listDesignProseReferences(db, contextId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.sourceEntryId).toBe(entryA)
  })

  it('adding a new reference on top of an existing one only inserts the new one', async () => {
    const { db, contextId, entryA, entryB } = await projectWithContext()
    await setContextJustificationWithReferences(db, contextId, 'v1', [entryA])
    const result = await setContextJustificationWithReferences(db, contextId, 'v2', [entryA, entryB])

    expect(result.createdReferences).toHaveLength(1)
    expect(result.createdReferences[0]?.sourceEntryId).toBe(entryB)
    expect(result.revivedReferences).toHaveLength(0)
    expect(result.tombstonedReferences).toHaveLength(0)
    expect((await listDesignProseReferences(db, contextId)).map((r) => r.sourceEntryId).sort()).toEqual(
      [entryA, entryB].sort(),
    )
  })

  it('removing a reference tombstones its row rather than hard-deleting it', async () => {
    const { db, contextId, entryA, entryB } = await projectWithContext()
    await setContextJustificationWithReferences(db, contextId, 'v1', [entryA, entryB])
    const result = await setContextJustificationWithReferences(db, contextId, 'v2', [entryA])

    expect(result.createdReferences).toHaveLength(0)
    expect(result.revivedReferences).toHaveLength(0)
    expect(result.tombstonedReferences).toHaveLength(1)
    expect(result.tombstonedReferences[0]?.sourceEntryId).toBe(entryB)
    expect(result.tombstonedReferences[0]?.deletedAt).not.toBeNull()
    expect((await listDesignProseReferences(db, contextId)).map((r) => r.sourceEntryId)).toEqual([entryA])
  })

  it('a reference still referenced across two commits is left completely untouched (same row id, no re-insert)', async () => {
    const { db, contextId, entryA, entryB } = await projectWithContext()
    const first = await setContextJustificationWithReferences(db, contextId, 'v1', [entryA, entryB])
    const idA = first.createdReferences.find((r) => r.sourceEntryId === entryA)?.id
    const idB = first.createdReferences.find((r) => r.sourceEntryId === entryB)?.id

    const second = await setContextJustificationWithReferences(db, contextId, 'v2', [entryA, entryB])
    expect(second.createdReferences).toHaveLength(0)
    expect(second.revivedReferences).toHaveLength(0)
    expect(second.tombstonedReferences).toHaveLength(0)

    const rows = await listDesignProseReferences(db, contextId)
    expect(rows.find((r) => r.sourceEntryId === entryA)?.id).toBe(idA)
    expect(rows.find((r) => r.sourceEntryId === entryB)?.id).toBe(idB)
  })

  it('the same entry referenced twice in one prose creates two rows — no uniqueness violation', async () => {
    const { db, contextId, entryA } = await projectWithContext()
    const result = await setContextJustificationWithReferences(db, contextId, 'v1', [entryA, entryA])

    expect(result.createdReferences).toHaveLength(2)
    expect(result.createdReferences.map((r) => r.sourceEntryId)).toEqual([entryA, entryA])
    expect(new Set(result.createdReferences.map((r) => r.id)).size).toBe(2)
    expect(await listDesignProseReferences(db, contextId)).toHaveLength(2)
  })

  it('dropping from two occurrences to one tombstones exactly one row, keeping the other live', async () => {
    const { db, contextId, entryA } = await projectWithContext()
    const first = await setContextJustificationWithReferences(db, contextId, 'v1', [entryA, entryA])
    const [rowId1, rowId2] = first.createdReferences.map((r) => r.id)

    const second = await setContextJustificationWithReferences(db, contextId, 'v2', [entryA])
    expect(second.createdReferences).toHaveLength(0)
    expect(second.tombstonedReferences).toHaveLength(1)
    const survivingRows = await listDesignProseReferences(db, contextId)
    expect(survivingRows).toHaveLength(1)
    // Exactly one of the two original rows survives live; the other was tombstoned.
    expect([rowId1, rowId2]).toContain(survivingRows[0]?.id)
    expect(second.tombstonedReferences[0]?.id).not.toBe(survivingRows[0]?.id)
  })

  it('re-referencing a tombstoned entry revives the SAME row instead of inserting a fresh one', async () => {
    const { db, contextId, entryA } = await projectWithContext()
    const first = await setContextJustificationWithReferences(db, contextId, 'v1', [entryA])
    const originalId = first.createdReferences[0]?.id

    const removed = await setContextJustificationWithReferences(db, contextId, 'v2', [])
    expect(removed.tombstonedReferences).toHaveLength(1)
    expect(removed.tombstonedReferences[0]?.id).toBe(originalId)

    const revived = await setContextJustificationWithReferences(db, contextId, 'v3', [entryA])
    expect(revived.createdReferences).toHaveLength(0)
    expect(revived.revivedReferences).toHaveLength(1)
    expect(revived.revivedReferences[0]?.id).toBe(originalId)

    const rows = await listDesignProseReferences(db, contextId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(originalId)
  })

  it('undo/redo round-trip via replaying the setter reaches the exact same row ids each time (multiset-stable)', async () => {
    const { db, contextId, entryA, entryB } = await projectWithContext()
    const forward = await setContextJustificationWithReferences(db, contextId, 'v2', [entryA, entryB])
    const idA = forward.createdReferences.find((r) => r.sourceEntryId === entryA)?.id
    const idB = forward.createdReferences.find((r) => r.sourceEntryId === entryB)?.id

    // Undo: replay the setter with the PRIOR state (empty justification, no references).
    const undone = await setContextJustificationWithReferences(db, contextId, '', [])
    expect(undone.context.justification).toBe('')
    expect(undone.tombstonedReferences.map((r) => r.id).sort()).toEqual([idA, idB].sort())

    // Redo: replay the setter with the forward state again — revives the SAME rows.
    const redone = await setContextJustificationWithReferences(db, contextId, 'v2', [entryA, entryB])
    expect(redone.context.justification).toBe('v2')
    expect(redone.revivedReferences.map((r) => r.id).sort()).toEqual([idA, idB].sort())
    expect(redone.createdReferences).toHaveLength(0)
  })

  it('atomicity: a mid-commit FK failure leaves the justification text AND every reference row unchanged', async () => {
    const { db, contextId, entryA } = await projectWithContext()
    await setContextJustificationWithReferences(db, contextId, 'original', [entryA])
    const before = await listDesignProseReferences(db, contextId)

    await expect(
      setContextJustificationWithReferences(db, contextId, 'attempted update', [
        entryA,
        'not-a-real-entry-id',
      ]),
    ).rejects.toThrow()

    const [contextRow] = await getContextsByIds(db, [contextId])
    expect(contextRow?.justification).toBe('original')
    const after = await listDesignProseReferences(db, contextId)
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id))
  })

  it('atomicity: a nonexistent context id rejects without touching design_prose_references', async () => {
    const { db, contextId, entryA } = await projectWithContext()
    await expect(
      setContextJustificationWithReferences(db, 'nonexistent-context', 'x', [entryA]),
    ).rejects.toThrow('context not found')
    expect(await listDesignProseReferences(db, contextId)).toHaveLength(0)
  })
})
