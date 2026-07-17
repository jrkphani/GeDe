import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../db/client'
import {
  addTier1Prop,
  addTier2Entry,
  addTier2Table,
  createContext,
  createProject,
  getTier1Purpose,
  listContextsForHeal,
  listTier1Props,
  listTier2EntriesForHeal,
  setContextJustification,
  setTier1ExistingScenario,
  setTier1PropDescription,
  setTier1Purpose,
  setTier2EntryDescription,
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

// Issue 089 D1 Phase 5 — the three remaining PROSE columns join the heal set.
// Identifier columns (*.name, contexts.symbol) are deferred and stay plain.

describe('healRichTextOnLoad — tier1_purpose.body (shared-row care)', () => {
  it('converts a plain-string body and enqueues op=update, WITHOUT clobbering existing_scenario', async () => {
    // existing_scenario is written first as already-rich Lexical JSON — it
    // shares the ONE tier1_purpose row with body and must survive the body heal.
    const richScenario = plainTextToRichJson('The current reality.')
    await setTier1ExistingScenario(db, projectId, richScenario)
    await setTier1Purpose(db, projectId, 'Ground the persona.')
    const purposeRowId = (await getTier1Purpose(db, projectId))?.id as string

    await healRichTextOnLoad(projectId)

    const row = await getTier1Purpose(db, projectId)
    // body converted to valid Lexical JSON; prose survives the round-trip.
    expect(safeRichTextJson(row?.body ?? null)).toBe(row?.body)
    expect(richTextToPlainText(row?.body ?? null)).toBe('Ground the persona.')
    // existing_scenario byte-for-byte untouched (the setter sets `body` only).
    expect(row?.existingScenario).toBe(richScenario)

    const entries = pendingEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.op).toBe('update')
    expect(entries[0]?.table).toBe('tier1_purpose')
    expect(entries[0]?.rowId).toBe(purposeRowId)
    expect(entries[0]?.row.body).toBe(row?.body)
  })

  it('skips an already-Lexical body — no write, no enqueue', async () => {
    const richBody = plainTextToRichJson('Already rich body.')
    await setTier1Purpose(db, projectId, richBody)

    await healRichTextOnLoad(projectId)

    expect((await getTier1Purpose(db, projectId))?.body).toBe(richBody)
    expect(pendingEntries()).toHaveLength(0)
  })
})

describe('healRichTextOnLoad — tier1_props.description', () => {
  async function descriptionOf(id: string): Promise<string | null> {
    const rows = await listTier1Props(db, projectId)
    return rows.find((r) => r.id === id)?.description ?? null
  }

  it('converts a plain-string description and enqueues op=update', async () => {
    const prop = await addTier1Prop(db, projectId, 'Seating comfort')
    await setTier1PropDescription(db, prop.id, 'Comfort, on demand.')

    await healRichTextOnLoad(projectId)

    const healed = await descriptionOf(prop.id)
    expect(safeRichTextJson(healed)).toBe(healed)
    expect(richTextToPlainText(healed)).toBe('Comfort, on demand.')

    const entries = pendingEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.op).toBe('update')
    expect(entries[0]?.table).toBe('tier1_props')
    expect(entries[0]?.rowId).toBe(prop.id)
    expect(entries[0]?.row.description).toBe(healed)
  })

  it('skips an already-Lexical description — no write, no enqueue', async () => {
    const prop = await addTier1Prop(db, projectId, 'Mobility')
    const rich = plainTextToRichJson('Already rich.')
    await setTier1PropDescription(db, prop.id, rich)

    await healRichTextOnLoad(projectId)

    expect(await descriptionOf(prop.id)).toBe(rich)
    expect(pendingEntries()).toHaveLength(0)
  })
})

describe('healRichTextOnLoad — tier2_entries.description', () => {
  async function descriptionOf(id: string): Promise<string | null> {
    const rows = await listTier2EntriesForHeal(db, projectId)
    return rows.find((r) => r.id === id)?.description ?? null
  }

  it('converts a plain-string description and enqueues op=update', async () => {
    const table = await addTier2Table(db, projectId, 'Value')
    const entry = await addTier2Entry(db, table.id, null, 'Comfort')
    await setTier2EntryDescription(db, entry.id, 'The rider stays comfortable.')

    await healRichTextOnLoad(projectId)

    const healed = await descriptionOf(entry.id)
    expect(safeRichTextJson(healed)).toBe(healed)
    expect(richTextToPlainText(healed)).toBe('The rider stays comfortable.')

    const entries = pendingEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.op).toBe('update')
    expect(entries[0]?.table).toBe('tier2_entries')
    expect(entries[0]?.rowId).toBe(entry.id)
    expect(entries[0]?.row.description).toBe(healed)
  })

  it('skips an already-Lexical description — no write, no enqueue', async () => {
    const table = await addTier2Table(db, projectId, 'Value')
    const entry = await addTier2Entry(db, table.id, null, 'Comfort')
    const rich = plainTextToRichJson('Already rich.')
    await setTier2EntryDescription(db, entry.id, rich)

    await healRichTextOnLoad(projectId)

    expect(await descriptionOf(entry.id)).toBe(rich)
    expect(pendingEntries()).toHaveLength(0)
  })
})
