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
import {
  listContextsForHeal,
  listTier1PurposeForHeal,
  listTier1Props,
  listTier2EntriesForHeal,
  setContextJustification,
  setTier1Purpose,
  setTier1PropDescription,
  setTier2EntryDescription,
  type ContextRow,
  type Tier1PropRow,
  type Tier1PurposeRow,
  type Tier2EntryRow,
} from '../db/mutations'
import { plainTextToRichJson, safeRichTextJson } from '../domain/richText'
import type { TableName } from '../domain/syncDelta'
import { requireDatabase } from './database'
import { enqueueIfSyncing } from './sync'

// One healable rich-text prose column. Structured so each prose column (P3/P5:
// justification, purpose body, the two descriptions) stays fully typed to its
// own Row via makeHealer's generic, so the heterogeneous set can live in one
// list without widening any getter to `unknown`.
interface RichTextColumn<Row extends { readonly updatedAt: string }> {
  // The sync table name the enqueued mutation targets.
  readonly table: TableName
  // Every LIVE row of this table for the project (all canvases, no tombstones).
  readonly read: (db: Database, projectId: string) => Promise<Row[]>
  // The row's own PRIMARY KEY — the id the enqueued sync delta targets. NOT
  // necessarily the value the setter keys on (tier1_purpose's setter keys on
  // projectId; its delta still targets the row's own id — see setTier1Purpose
  // in tier1.ts's enqueue).
  readonly getId: (row: Row) => string
  // The prose value in EITHER shape (legacy plain string OR Lexical JSON).
  readonly getValue: (row: Row) => string | null
  // Rows the heal may touch. A hook for columns that must exclude some rows;
  // every current column heals every live row it reads.
  readonly isTargetable: (row: Row) => boolean
  // The existing per-column DB writer, reused verbatim. Receives the ROW (not
  // just an id) so a setter keyed on something other than the PK — e.g.
  // setTier1Purpose, keyed on projectId — can still be reused as-is, WITHOUT
  // disturbing the row's sibling columns (setTier1Purpose's upsert sets `body`
  // only, so `existing_scenario` on the shared tier1_purpose row is untouched).
  // Returns the updated row (with its fresh updatedAt) so the enqueue envelope
  // carries the real converted value.
  readonly set: (db: Database, row: Row, value: string) => Promise<Row>
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
      const updated = await col.set(db, row, plainTextToRichJson(value))
      // Op MUST be 'update': these rows already exist, and the server insert is
      // `ON CONFLICT (id) DO NOTHING` (src/server/writeApi/store.ts) — 'upsert'
      // would map to 'insert' and silently no-op (the 066-class bug). Bypasses
      // the command log entirely: a bulk normalization must never pollute
      // undo/redo.
      //
      // Issue 091 — tag this as a heal-originated (`origin: 'heal'`) BACKGROUND
      // write. If the row's own INSERT hasn't flushed server-side yet, the
      // server rejects this update `unknown_entity`; because the heal is
      // repeatable and self-corrects next load, flush() (sync.ts) drops the
      // rejected entry but suppresses the cosmetic status note for it. A
      // user-initiated edit of a genuinely-missing row stays untagged and still
      // surfaces the note.
      enqueueIfSyncing(col.table, col.getId(updated), 'update', updated, 'heal')
    }
  }
}

// The heal set — every PROSE rich-text column. Identifier columns (*.name,
// contexts.symbol) are deliberately EXCLUDED (owner decision, deferred): they
// are not rich cells, so converting them would make their still-plain renderers
// show raw JSON. A column belongs here only once its UI cell is a rich cell.
//   • contexts.justification    (P3) — the rich justification cell.
//   • tier1_purpose.body        (P5) — the standalone Purpose rich editor.
//   • tier1_props.description    (P5) — the rich description grid cell.
//   • tier2_entries.description  (P5) — the rich description grid cell.
const HEALERS: readonly ((db: Database, projectId: string) => Promise<void>)[] = [
  makeHealer<ContextRow>({
    table: 'contexts',
    read: listContextsForHeal,
    getId: (row) => row.id,
    getValue: (row) => row.justification,
    isTargetable: () => true,
    set: (db, row, value) => setContextJustification(db, row.id, value),
  }),
  // tier1_purpose.body — the Purpose statement. The setter keys on projectId
  // (unique per-project row, a true upsert) and updates `body` ONLY, so the
  // sibling `existing_scenario` on the same row (already rich) is never
  // disturbed. The enqueue delta still targets the row's own PK (getId → id),
  // matching tier1.ts's setPurpose enqueue. Op 'update': the row exists (it was
  // just read live), so the server insert's ON CONFLICT (id) DO NOTHING must be
  // bypassed via 'update' (the 066-class rule).
  makeHealer<Tier1PurposeRow>({
    table: 'tier1_purpose',
    read: listTier1PurposeForHeal,
    getId: (row) => row.id,
    getValue: (row) => row.body,
    isTargetable: () => true,
    set: async (db, row, value) => {
      const updated = await setTier1Purpose(db, row.projectId, value)
      // The row was read live in this same pass, so the projectId-keyed upsert
      // always hits the conflict branch and returns it; `?? row` only satisfies
      // the non-null return type for a path that cannot occur here.
      return updated ?? row
    },
  }),
  // tier1_props.description — the ranked value-proposition description cell.
  makeHealer<Tier1PropRow>({
    table: 'tier1_props',
    read: listTier1Props,
    getId: (row) => row.id,
    getValue: (row) => row.description,
    isTargetable: () => true,
    set: (db, row, value) => setTier1PropDescription(db, row.id, value),
  }),
  // tier2_entries.description — the architecture entry description cell (all
  // entries across every live table in the project).
  makeHealer<Tier2EntryRow>({
    table: 'tier2_entries',
    read: listTier2EntriesForHeal,
    getId: (row) => row.id,
    getValue: (row) => row.description,
    isTargetable: () => true,
    set: (db, row, value) => setTier2EntryDescription(db, row.id, value),
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
