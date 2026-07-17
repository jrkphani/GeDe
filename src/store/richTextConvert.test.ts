import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client'
import {
  createContext,
  createProject,
  listContextsForHeal,
  setContextJustification,
} from '../db/mutations'
import { plainTextToRichJson, richTextToPlainText, safeRichTextJson } from '../domain/richText'
import { useCommandLogStore } from './commandLog'
import { setDatabase } from './database'
import { healRichTextOnLoad } from './richTextConvert'
import { resetSyncStore, useSyncStore } from './sync'

// Issue 089 D1 Phase 4 — the app-layer heal that converts legacy plain-string
// justification cells to Lexical JSON on every project load. See richTextConvert.ts
// for WHY it is a repeatable, value-gated heal rather than a one-shot migration.

let db: Awaited<ReturnType<typeof openDatabase>>['db']
let projectId: string

async function justificationOf(id: string): Promise<string | null> {
  const rows = await listContextsForHeal(db, projectId)
  return rows.find((r) => r.id === id)?.justification ?? null
}

function pendingEntries() {
  return useSyncStore.getState().queue.entries.filter((e) => e.status === 'pending')
}

beforeEach(async () => {
  ;({ db } = await openDatabase('memory://'))
  setDatabase(db)
  resetSyncStore()
  useCommandLogStore.getState().clear()
  const project = await createProject(db, { name: 'Tavalo' })
  projectId = project.id
  // A sync workspace so enqueueIfSyncing actually queues (mirrors the other
  // store tests). Without this the heal still converts the DB value; it just
  // enqueues nothing.
  useSyncStore.setState({ workspaceId: 'ws1' })
})

describe('healRichTextOnLoad — legacy plain-string → Lexical JSON', () => {
  it('converts a plain-string justification to valid Lexical JSON and enqueues op=update', async () => {
    const ctx = await createContext(db, projectId)
    await setContextJustification(db, ctx.id, 'It grounds the persona.')

    await healRichTextOnLoad(projectId)

    const healed = await justificationOf(ctx.id)
    expect(healed).not.toBeNull()
    // Valid Lexical JSON now (passes the P2 security/loop-guard closure)...
    expect(safeRichTextJson(healed)).toBe(healed)
    // ...and the authored prose survives the round-trip.
    expect(richTextToPlainText(healed)).toBe('It grounds the persona.')

    const entries = pendingEntries()
    expect(entries).toHaveLength(1)
    // Op MUST be 'update' — an existing row; 'upsert' maps to insert (ON
    // CONFLICT DO NOTHING) and would silently no-op server-side (066-class bug).
    expect(entries[0]?.op).toBe('update')
    expect(entries[0]?.table).toBe('contexts')
    expect(entries[0]?.rowId).toBe(ctx.id)
    // The enqueued row carries the CONVERTED value, not the stale plain string.
    expect(entries[0]?.row.justification).toBe(healed)
  })

  it('skips a value already stored as Lexical JSON — no write, no enqueue (idempotent)', async () => {
    const ctx = await createContext(db, projectId)
    const alreadyJson = plainTextToRichJson('Already rich.')
    await setContextJustification(db, ctx.id, alreadyJson)

    await healRichTextOnLoad(projectId)

    // Byte-for-byte unchanged: the skip-guard short-circuits before any write.
    expect(await justificationOf(ctx.id)).toBe(alreadyJson)
    expect(pendingEntries()).toHaveLength(0)
  })

  it('skips null and empty justifications', async () => {
    const nullCtx = await createContext(db, projectId) // justification defaults to null
    const emptyCtx = await createContext(db, projectId)
    await setContextJustification(db, emptyCtx.id, '   ')

    await healRichTextOnLoad(projectId)

    expect(await justificationOf(nullCtx.id)).toBeNull()
    expect(await justificationOf(emptyCtx.id)).toBe('   ')
    expect(pendingEntries()).toHaveLength(0)
  })

  it('is a no-op on the second run (already-Lexical cells are skipped)', async () => {
    const ctx = await createContext(db, projectId)
    await setContextJustification(db, ctx.id, 'Convert me once.')

    await healRichTextOnLoad(projectId)
    const afterFirst = await justificationOf(ctx.id)
    expect(pendingEntries()).toHaveLength(1)

    // Second run: no additional conversion, no additional enqueue.
    await healRichTextOnLoad(projectId)
    expect(await justificationOf(ctx.id)).toBe(afterFirst) // unchanged
    expect(pendingEntries()).toHaveLength(1) // still just the one from run 1
  })

  it('re-heals a cell a peer clobbered back to plain text (LWW is value-blind)', async () => {
    const ctx = await createContext(db, projectId)
    await setContextJustification(db, ctx.id, 'First convert.')
    await healRichTextOnLoad(projectId)
    expect(safeRichTextJson(await justificationOf(ctx.id))).not.toBeNull()

    // Simulate an un-upgraded peer's inbound delta: a plain string written with
    // a newer updated_at. setContextJustification stamps now(), so the DB now
    // holds a plain string again — exactly the mixed-version clobber.
    await setContextJustification(db, ctx.id, 'Peer clobbered me back to plain.')
    expect(safeRichTextJson(await justificationOf(ctx.id))).toBeNull()

    // Next load re-heals it.
    await healRichTextOnLoad(projectId)
    const reHealed = await justificationOf(ctx.id)
    expect(safeRichTextJson(reHealed)).toBe(reHealed)
    expect(richTextToPlainText(reHealed)).toBe('Peer clobbered me back to plain.')
  })

  it('does NOT push to the command log (undo stack unchanged)', async () => {
    const ctx = await createContext(db, projectId)
    await setContextJustification(db, ctx.id, 'Should not be undoable.')
    useCommandLogStore.getState().clear()

    await healRichTextOnLoad(projectId)

    expect(useCommandLogStore.getState().past).toHaveLength(0)
    expect(useCommandLogStore.getState().future).toHaveLength(0)
  })

  it('with no sync workspace set, still converts the DB value but enqueues nothing', async () => {
    resetSyncStore() // clears workspaceId
    const ctx = await createContext(db, projectId)
    await setContextJustification(db, ctx.id, 'Local-only convert.')

    await healRichTextOnLoad(projectId)

    expect(safeRichTextJson(await justificationOf(ctx.id))).not.toBeNull()
    expect(pendingEntries()).toHaveLength(0)
  })
})
