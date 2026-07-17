// Issue 089 D1 Phase 4 — the app-layer, repeatable, value-gated heal that
// converts legacy plain-string prose cells to Lexical JSON on every project
// load.
//
// WHY a repeatable heal and NOT a one-shot migration: LWW conflict resolution
// is value-BLIND. Both the server (src/domain/mutationProtocol.ts's
// resolveLastWriteWins) and every peer's inbound apply (src/db/sync.ts's
// `updatedAt < delta.updatedAt`) compare ONLY `updated_at` — nothing inspects
// value type. So during a mixed-version rollout an un-upgraded client can write
// a plain string with a newer `updated_at` and clobber a converted cell back to
// plain text. Therefore this must run on EVERY load, be idempotent (skip cells
// already valid Lexical JSON via safeRichTextJson), and re-heal any regressed
// cell on the next load. Because P3's rich cell already renders legacy plain
// strings correctly and wraps-on-edit, this is a PROACTIVE normalization, not a
// correctness gate — it stays safe and cheap.
import type { Database } from '../db/client'
import { listContextsForHeal, setContextJustification, type ContextRow } from '../db/mutations'
import { plainTextToRichJson, safeRichTextJson } from '../domain/richText'
import type { TableName } from '../domain/syncDelta'
import { requireDatabase } from './database'
import { enqueueIfSyncing } from './sync'

// One healable rich-text prose column. Structured so P5 can append the other
// prose columns (descriptions/body/names) as they each become rich cells —
// each entry stays fully typed to its own Row via makeHealer's generic, so the
// heterogeneous set can live in one list without widening any getter to
// `unknown`. For THIS phase there is exactly one rich column: contexts.justification.
interface RichTextColumn<Row extends { readonly updatedAt: string }> {
  // The sync table name the enqueued mutation targets.
  readonly table: TableName
  // Every LIVE row of this table for the project (all canvases, no tombstones).
  readonly read: (db: Database, projectId: string) => Promise<Row[]>
  readonly getId: (row: Row) => string
  // The prose value in EITHER shape (legacy plain string OR Lexical JSON).
  readonly getValue: (row: Row) => string | null
  // Rows the heal may touch (defaults to all). A hook for P5 columns that must
  // exclude some rows; contexts.justification heals every live row.
  readonly isTargetable: (row: Row) => boolean
  // The existing per-column DB writer, reused verbatim. Returns the updated row
  // (with its fresh updatedAt) so the enqueue envelope carries the real value.
  readonly set: (db: Database, id: string, value: string) => Promise<Row>
}

// Turns a typed column config into a runner. Erases Row at the call boundary so
// HEALERS below can hold columns of different Row types in one array, while each
// runner stays type-checked against its own config.
function makeHealer<Row extends { readonly updatedAt: string }>(
  col: RichTextColumn<Row>,
): (db: Database, projectId: string) => Promise<void> {
  return async (db, projectId) => {
    const rows = await col.read(db, projectId)
    for (const row of rows) {
      if (!col.isTargetable(row)) continue
      const value = col.getValue(row)
      // Nothing to convert: an empty/absent cell round-trips to '' either way.
      if (value === null || value.trim() === '') continue
      // Idempotent skip-guard: a cell that is ALREADY valid Lexical JSON is left
      // untouched — no write, no enqueue. This is what makes a second run (and
      // the delta-driven re-read) a no-op, and what stops any conversion loop:
      // plainTextToRichJson's output is guaranteed to pass safeRichTextJson (the
      // P2 closure), so a healed cell is skipped forever after.
      //
      // The `{`-prefix fast-path mirrors richTextToPlainText (richText.ts): a
      // serialized Lexical EditorState is always a JSON object literal
      // (`{"root":...}`), a legacy plain string (almost) never starts with `{`.
      // Routing every plain string through safeRichTextJson would fire its
      // fail-closed `console.error` (meant for a tampered sync payload at the
      // 081 security boundary) for EVERY legacy cell on the first post-deploy
      // load — a scary log storm for the expected "not converted yet" case. So
      // a non-`{` value skips straight to conversion; only a `{`-shaped value
      // (real JSON, or the rare plain string that happens to start with `{`) is
      // validated — the identical tradeoff richTextToPlainText already makes.
      if (value.trimStart().startsWith('{') && safeRichTextJson(value) !== null) continue
      // Legacy plain string → wrap as a single-paragraph Lexical doc, write it
      // through the existing setter, and enqueue the SYNC mutation.
      const updated = await col.set(db, col.getId(row), plainTextToRichJson(value))
      // Op MUST be 'update': these rows already exist, and the server insert is
      // `ON CONFLICT (id) DO NOTHING` (src/server/writeApi/store.ts) — 'upsert'
      // would map to 'insert' and silently no-op (the 066-class bug). Bypasses
      // the command log entirely: a bulk normalization must never pollute
      // undo/redo.
      enqueueIfSyncing(col.table, col.getId(updated), 'update', updated)
    }
  }
}

// The heal set. ONLY contexts.justification for this phase — the sole rich column
// so far. Do NOT add descriptions/body/names here until P5 makes their cells
// rich: converting them now would make their still-plain MultilineCell render
// raw JSON.
const HEALERS: readonly ((db: Database, projectId: string) => Promise<void>)[] = [
  makeHealer<ContextRow>({
    table: 'contexts',
    read: listContextsForHeal,
    getId: (row) => row.id,
    getValue: (row) => row.justification,
    isTargetable: () => true,
    set: setContextJustification,
  }),
]

// Convert every legacy plain-string prose cell in `projectId` to Lexical JSON.
// Idempotent and repeatable: running twice, or after a peer re-introduces a
// plain string, re-heals ONLY the not-yet-Lexical cells. Bypasses the command
// log; does not narrate. Called on project open, AFTER the contexts read settles.
export async function healRichTextOnLoad(projectId: string): Promise<void> {
  const db = requireDatabase()
  for (const heal of HEALERS) {
    await heal(db, projectId)
  }
}
