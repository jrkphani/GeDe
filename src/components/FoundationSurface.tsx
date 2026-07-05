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
import { useTier1Store } from '../store/tier1'
import { EditableGrid, type GridColumn } from './EditableGrid'
import { Button } from './ui/button'
import { MultilineEdit } from './ui/multiline-editor'

const PURPOSE_GHOST = 'What is this system for?'

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
  const purpose = useTier1Store((s) => s.purpose)
  const props = useTier1Store((s) => s.props)
  const load = useTier1Store((s) => s.load)
  const setPurpose = useTier1Store((s) => s.setPurpose)
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
        render: (prop) => <RankCell prop={prop} rank={displayRankById[prop.id] ?? prop.rank} />,
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
        kind: 'multiline',
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

      {/* Purpose: a paper panel that reads as a paragraph, edited in place and
          autosaved through the mutation layer like any cell (design brief). */}
      <section className="panel tier1-purpose">
        <MultilineEdit
          value={purpose}
          onCommit={(next) => void setPurpose(next)}
          display={
            purpose ? (
              <span className="tier1-purpose__body">{purpose}</span>
            ) : (
              <span className="tier1-purpose__ghost">{PURPOSE_GHOST}</span>
            )
          }
          displayClassName="tier1-purpose__display"
          inputClassName="tier1-purpose__input"
          ariaLabel="System purpose"
        />
      </section>

      <section className="tier1-props" data-empty={props.length === 0 || undefined}>
        <DndContext collisionDetection={closestCenter} onDragOver={onDragOver} onDragEnd={onDragEnd}>
          <SortableContext items={propIds} strategy={verticalListSortingStrategy}>
            <EditableGrid
              rows={props}
              columns={columns}
              getRowId={(prop) => prop.id}
              phantom={{
                columnId: 'name',
                placeholder: 'Name a value proposition',
                onCreate: (name) => void addProp(name),
              }}
            />
          </SortableContext>
        </DndContext>
      </section>
    </main>
  )
}
