import { DndContext, closestCenter, type DragEndEvent, type DragOverEvent } from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useEffect, useMemo, useState } from 'react'
import type { Tier1PropRow } from '../db/mutations'
import { formatDegree } from '../domain/degree'
import { canWrite } from '../domain/workspaceRole'
import { useTier1Store } from '../store/tier1'
import { useWorkspaceRole } from '../store/workspace'
import { EditableGrid, type GridColumn } from './EditableGrid'
import { Button } from './ui/button'
import { RichTextEditor } from './ui/rich-text-editor'

const PURPOSE_GHOST = 'What is this system for?'
const EXISTING_SCENARIO_GHOST = 'Describe the existing scenario…'

// The rank cell (issue 013) is the one tier-1-specific cell renderer: mono
// degree notation + a hover drag handle. dnd-kit's sortable node is the cell
// itself — EditableGrid owns the <tr> and stays unchanged (the slice's whole
// point). Live renumber during a drag is the consequence-preview (design
// brief): the digit updates before drop, even though the row doesn't slide.
function RankCell({ prop, rank }: { prop: Tier1PropRow; rank: number }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: prop.id,
  })
  return (
    <div
      ref={setNodeRef}
      className="tier1-rank"
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-dragging={isDragging || undefined}
    >
      <Button
        variant="bare"
        className="drag-handle"
        aria-label={`Reorder ${prop.name}`}
        {...attributes}
        {...listeners}
      >
        ⋮⋮
      </Button>
      <span className="tier1-rank__degree font-mono">{formatDegree(rank)}</span>
    </div>
  )
}

// SPEC §4.6 / SITEMAP §1 — the Foundation tab: purpose statement + a table of
// ranked value propositions. The most document-like tier: single column,
// purpose above the table, on the graph-paper ground. No context bar here
// (SITEMAP §2 — Foundation's bar is empty, so it stays hidden).
export function FoundationSurface({ projectId }: { projectId: string }) {
  // Issue 035 — a viewer sees the same purpose + ranked table, minus the
  // in-place purpose edit, re-rank drag, and phantom row.
  const { role } = useWorkspaceRole(projectId)
  const readOnly = !canWrite(role)
  const purpose = useTier1Store((s) => s.purpose)
  const existingScenario = useTier1Store((s) => s.existingScenario)
  const props = useTier1Store((s) => s.props)
  const load = useTier1Store((s) => s.load)
  const setPurpose = useTier1Store((s) => s.setPurpose)
  const setExistingScenario = useTier1Store((s) => s.setExistingScenario)
  const addProp = useTier1Store((s) => s.addProp)
  const renameProp = useTier1Store((s) => s.renameProp)
  const setDescription = useTier1Store((s) => s.setDescription)
  const reorderProp = useTier1Store((s) => s.reorderProp)

  // Live re-rank preview: while dragging, `previewOrder` overrides the stored
  // order so the rank digits renumber before the drop commits.
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null)

  useEffect(() => {
    void load(projectId)
  }, [projectId, load])

  const propIds = props.map((p) => p.id)
  const displayRankById = useMemo(() => {
    const order = previewOrder ?? propIds
    return Object.fromEntries(order.map((id, i) => [id, i + 1]))
    // propIds is derived from props; recompute when either it or the preview moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewOrder, props])

  function onDragOver(event: DragOverEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const base = previewOrder ?? propIds
    const from = base.indexOf(String(active.id))
    const to = base.indexOf(String(over.id))
    if (from === -1 || to === -1) return
    setPreviewOrder(arrayMove(base, from, to))
  }

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event
    const order = previewOrder
    setPreviewOrder(null)
    if (!over) return
    const toIndex = (order ?? propIds).indexOf(String(active.id))
    if (toIndex >= 0) void reorderProp(String(active.id), toIndex)
  }

  const columns: GridColumn<Tier1PropRow>[] = [
    {
      id: 'rank',
      header: 'Rank',
      headClassName: 'tier1-col--rank',
      cellClassName: 'tier1-col--rank',
      cell: {
        kind: 'static',
        // Issue 035 — a viewer sees the same degree notation, minus the drag
        // handle (there's nothing for it to reorder into, RLS-wise).
        render: (prop) =>
          readOnly ? (
            <span className="tier1-rank__degree font-mono">
              {formatDegree(displayRankById[prop.id] ?? prop.rank)}
            </span>
          ) : (
            <RankCell prop={prop} rank={displayRankById[prop.id] ?? prop.rank} />
          ),
      },
    },
    {
      id: 'name',
      header: 'Name',
      cell: {
        kind: 'text',
        getValue: (prop) => prop.name,
        onCommit: async (prop, value) => {
          // Never let a cleared name orphan a row (there is no name-delete
          // affordance in this slice); an empty commit is a no-op revert.
          if (value.length > 0 && value !== prop.name) await renameProp(prop.id, value)
          return value.length > 0
        },
      },
    },
    {
      id: 'description',
      header: 'Description',
      cell: {
        // Issue 089 D1 Phase 5 — the value-proposition description is now a rich
        // cell (Lexical), mirroring the justification column (P3). Same stored-
        // string value contract in/out; legacy plain strings still render and
        // wrap-on-edit. The global FormatStrip binds when this cell is focused.
        kind: 'richtext',
        placeholder: 'Add description…',
        getValue: (prop) => prop.description ?? '',
        onCommit: async (prop, value) => {
          await setDescription(prop.id, value)
          return true
        },
      },
    },
  ]

  return (
    <main className="foundation">
      <h2 className="tier1-header">1st Tier · Foundation</h2>

      {/* Purpose: a paper panel that reads as a paragraph. Issue 089 D1 Phase 5
          — now a standalone rich-text editor (Lexical), exactly like the
          sibling Existing Scenario below; the two coexist and both bind to the
          global FormatStrip when focused. Commit-on-blur → setPurpose, storing
          the editor's own JSON (a legacy plain string still renders and
          wraps-on-edit). Purpose and Existing Scenario SHARE one tier1_purpose
          row but are edited through independent setters, so a purpose edit
          never disturbs the scenario prose (setTier1Purpose sets `body` only).
          setPurpose keeps the '' empty convention, so onCommit's null (an
          emptied editor) maps back to ''. */}
      <section className="panel tier1-purpose">
        {/* Issue 103 — a visible label matching Existing Scenario's. Purpose
            previously carried only an ariaLabel, so it read as a stray card
            rather than a titled field; the label is the biggest driver of the
            "these boxes look like stray tables" complaint. The editor keeps its
            own ariaLabel ("System purpose") for the accessible name. */}
        <span className="tier1-purpose__label">Purpose</span>
        <RichTextEditor
          value={purpose || null}
          onCommit={(next) => void setPurpose(next ?? '')}
          ariaLabel="System purpose"
          placeholder={PURPOSE_GHOST}
          namespace="gede-tier1-purpose"
          readOnly={readOnly}
        />
      </section>

      {/* Existing scenario (issue 081): the current reality before this
          design intervenes — strictly between Purpose and the value
          architecture table (design brief's canonical reading order: why ->
          current reality -> proposed value). A rich-text panel, not a flat
          text blob, since the designer is drafting prose here. */}
      <section className="panel tier1-existing-scenario">
        <span className="tier1-existing-scenario__label">Existing scenario</span>
        <RichTextEditor
          value={existingScenario}
          onCommit={(next) => void setExistingScenario(next)}
          ariaLabel="Existing scenario"
          placeholder={EXISTING_SCENARIO_GHOST}
          readOnly={readOnly}
        />
      </section>

      <section className="tier1-props" data-empty={props.length === 0 || undefined}>
        {/* Issue 103 — a visible section heading so the ranked table reads as a
            titled table, not a third mystery card stacked under two prose panels.
            An <h3> keeps the heading outline valid (h2 "1st Tier · Foundation" →
            h3); the section stays an un-named <section> (no aria-labelledby), so
            no new landmark is introduced. */}
        <h3 className="tier1-props__heading">Value propositions</h3>

        {/* Issue 103 — an orienting empty-state line (mirrors Architecture's
            .t2-empty, issue 084 finding 1) so a 0-prop grid + bare phantom reads
            as "type here to add", not a stray link. Only for an editor: a viewer
            has no phantom to point at. */}
        {props.length === 0 && !readOnly ? (
          <p className="tier1-props__empty">
            No value propositions yet. Name your first below — e.g. “Comfort on demand”,
            “Effortless booking”.
          </p>
        ) : null}

        {readOnly ? (
          <EditableGrid rows={props} columns={columns} getRowId={(prop) => prop.id} readOnly />
        ) : (
          <DndContext collisionDetection={closestCenter} onDragOver={onDragOver} onDragEnd={onDragEnd}>
            <SortableContext items={propIds} strategy={verticalListSortingStrategy}>
              <EditableGrid
                rows={props}
                columns={columns}
                getRowId={(prop) => prop.id}
                // Issue 103 — teach the existing Enter/Tab phantom grammar with
                // the same quiet, aria-hidden key hints Architecture already
                // uses (issue 084 D3 P5). Additive; adds no screen-reader noise
                // (KeyHint's root is aria-hidden).
                showKeyHints
                phantom={{
                  columnId: 'name',
                  placeholder: 'Name a value proposition',
                  onCreate: (name) => void addProp(name),
                }}
              />
            </SortableContext>
          </DndContext>
        )}
      </section>
    </main>
  )
}
