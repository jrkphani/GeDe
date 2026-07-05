import * as Popover from '@radix-ui/react-popover'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useState } from 'react'
import type { DimensionRow } from '../db/mutations'
import { useDimensionsStore } from '../store/dimensions'
import { DIMENSION_PALETTE } from '../theme/palette'
import { ParameterList } from './ParameterList'

const FLOOR_TOOLTIP = 'A canvas needs at least 2 dimensions'

function SwatchPicker({ dimension, onDone }: { dimension: DimensionRow; onDone: () => void }) {
  const setColor = useDimensionsStore((s) => s.setColor)
  const [hex, setHex] = useState(dimension.color)
  return (
    <div className="palette-picker">
      {DIMENSION_PALETTE.map((color) => (
        <button
          key={color}
          className="swatch"
          style={{ background: color }}
          aria-label={`Use ${color}`}
          aria-pressed={dimension.color === color}
          onClick={() => {
            void setColor(dimension.id, color).then(onDone)
          }}
        />
      ))}
      <input
        className="inplace-input palette-picker__hex"
        aria-label="Custom color"
        value={hex}
        onChange={(e) => setHex(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && /^#[0-9a-fA-F]{6}$/.test(hex)) {
            void setColor(dimension.id, hex).then(onDone)
          }
          if (e.key === 'Escape') onDone()
        }}
      />
    </div>
  )
}

function DimensionItem({
  dimension,
  index,
  editing,
  setEditing,
  canRemove,
}: {
  dimension: DimensionRow
  index: number
  editing: boolean
  setEditing: (id: string | null) => void
  canRemove: boolean
}) {
  const rename = useDimensionsStore((s) => s.rename)
  const reorder = useDimensionsStore((s) => s.reorder)
  const remove = useDimensionsStore((s) => s.remove)
  const [draft, setDraft] = useState(dimension.name)
  const [picking, setPicking] = useState(false)
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: dimension.id,
  })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="dim-section"
    >
      <div
        className="dim-row"
        data-color={dimension.color}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.altKey && e.key === 'ArrowUp') {
            e.preventDefault()
            void reorder(dimension.id, index - 1)
          }
          if (e.altKey && e.key === 'ArrowDown') {
            e.preventDefault()
            void reorder(dimension.id, index + 1)
          }
        }}
      >
        <button
          className="drag-handle"
          aria-label={`Reorder ${dimension.name}`}
          {...attributes}
          {...listeners}
        >
          ⋮⋮
        </button>
        <button
          className="swatch"
          style={{ background: dimension.color }}
          aria-label={`Color of ${dimension.name}`}
          onClick={() => setPicking(!picking)}
        />
        {editing ? (
          <input
            className="inplace-input dim-row__name--head"
            value={draft}
            autoFocus
            onFocus={(e) => e.target.select()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => setEditing(null)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                const next = draft.trim()
                if (next && next !== dimension.name) void rename(dimension.id, next)
                setEditing(null)
              }
              if (e.key === 'Escape') setEditing(null)
            }}
          />
        ) : (
          <span
            className="dim-row__name dim-row__name--head"
            onClick={() => {
              setDraft(dimension.name)
              setEditing(dimension.id)
            }}
          >
            {dimension.name}
          </span>
        )}
        <button
          className="row-action"
          aria-label={`Remove ${dimension.name}`}
          disabled={!canRemove}
          title={canRemove ? undefined : FLOOR_TOOLTIP}
          onClick={() => void remove(dimension.id)}
        >
          Remove
        </button>
        {picking && <SwatchPicker dimension={dimension} onDone={() => setPicking(false)} />}
      </div>
      <ParameterList dimensionId={dimension.id} />
    </div>
  )
}

// Exported for direct testing and for the guided start (issue 002 design
// brief: the manager is already open when a canvas has fewer than 2 dims).
export function DimensionManagerPanel() {
  const dimensions = useDimensionsStore((s) => s.dimensions)
  const add = useDimensionsStore((s) => s.add)
  const reorder = useDimensionsStore((s) => s.reorder)
  const editingId = useDimensionsStore((s) => s.editingId)
  const setEditingId = useDimensionsStore((s) => s.setEditing)
  const canRemove = dimensions.length > 2

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const toIndex = dimensions.findIndex((d) => d.id === over.id)
    if (toIndex >= 0) void reorder(String(active.id), toIndex)
  }

  return (
    <div className="dim-manager">
      <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={dimensions.map((d) => d.id)} strategy={verticalListSortingStrategy}>
          {dimensions.map((d, i) => (
            <DimensionItem
              key={d.id}
              dimension={d}
              index={i}
              editing={editingId === d.id}
              setEditing={setEditingId}
              canRemove={canRemove}
            />
          ))}
        </SortableContext>
      </DndContext>
      <button
        className="row-action dim-manager__add"
        onClick={() => {
          void add() // opens the new row's editor via the same store update
        }}
      >
        Add dimension
      </button>
    </div>
  )
}

export function DimensionManager() {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className="row-action">Dimensions</button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="popover"
          align="start"
          sideOffset={4}
          onEscapeKeyDown={(e) => {
            // Esc order (SITEMAP §4): close the in-place editor first, the
            // popover on the next press — never both at once.
            if (e.target instanceof HTMLElement && e.target.tagName === 'INPUT') {
              e.preventDefault()
            }
          }}
        >
          <DimensionManagerPanel />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
