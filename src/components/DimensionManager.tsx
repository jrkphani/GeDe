import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useState } from 'react'
import type { DimensionRow } from '../db/mutations'
import { computeRemovalImpact } from '../domain/dimensionImpact'
import { useContextsStore } from '../store/contexts'
import { useDimensionsStore } from '../store/dimensions'
import { DIMENSION_PALETTE } from '../theme/palette'
import { ParameterList } from './ParameterList'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { InlineEdit } from './ui/inline-editor'
import { Popover, PopoverContent, PopoverTrigger, keepPopoverOpenWhileEditing } from './ui/popover'
import { SwatchButton } from './ui/swatch'

const FLOOR_TOOLTIP = 'A canvas needs at least 2 dimensions'

function SwatchPicker({ dimension, onDone }: { dimension: DimensionRow; onDone: () => void }) {
  const setColor = useDimensionsStore((s) => s.setColor)
  const [hex, setHex] = useState(dimension.color)
  return (
    <div className="palette-picker">
      {DIMENSION_PALETTE.map((color) => (
        <SwatchButton
          key={color}
          color={color}
          aria-label={`Use ${color}`}
          aria-pressed={dimension.color === color}
          onClick={() => {
            void setColor(dimension.id, color).then(onDone)
          }}
        />
      ))}
      <Input
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

// SPEC invariant 4 / STYLE_GUIDE §9 — the one confirm in the app: remove is
// destructive at a distance (bindings on every context that used it), so it
// gets an anchored popover with the exact impact numbers instead of a bare
// "Are you sure?". Add never confirms — it destroys nothing.
function RemoveDimensionConfirm({
  dimension,
  canRemove,
}: {
  dimension: DimensionRow
  canRemove: boolean
}) {
  const remove = useDimensionsStore((s) => s.remove)
  const bindingsByContext = useContextsStore((s) => s.bindingsByContext)
  const [open, setOpen] = useState(false)
  const { bindingCount } = computeRemovalImpact(dimension.id, bindingsByContext)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-label={`Remove ${dimension.name}`}
          disabled={!canRemove}
          title={canRemove ? undefined : FLOOR_TOOLTIP}
        >
          Remove
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="remove-dimension-confirm">
        <p className="remove-dimension-confirm__copy">
          Remove <strong>{dimension.name}</strong>? Deletes{' '}
          <span className="font-mono">{bindingCount}</span>{' '}
          {bindingCount === 1 ? 'binding' : 'bindings'}.
        </p>
        <div className="remove-dimension-confirm__actions">
          <Button variant="bare" className="row-action" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            aria-label={`Confirm remove ${dimension.name}`}
            onClick={() => {
              void remove(dimension.id).then(() => setOpen(false))
            }}
          >
            Remove
          </Button>
        </div>
      </PopoverContent>
    </Popover>
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
        <Button
          variant="bare"
          className="drag-handle"
          aria-label={`Reorder ${dimension.name}`}
          {...attributes}
          {...listeners}
        >
          ⋮⋮
        </Button>
        <SwatchButton
          color={dimension.color}
          aria-label={`Color of ${dimension.name}`}
          onClick={() => setPicking(!picking)}
        />
        <InlineEdit
          value={dimension.name}
          onCommit={(next) => void rename(dimension.id, next)}
          display={dimension.name}
          displayClassName="dim-row__name dim-row__name--head"
          inputClassName="dim-row__name--head"
          selectOnFocus
          stopPropagation
          editing={editing}
          onEditingChange={(next) => setEditing(next ? dimension.id : null)}
        />
        <RemoveDimensionConfirm dimension={dimension} canRemove={canRemove} />
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
      <Button
        className="dim-manager__add"
        onClick={() => {
          void add() // opens the new row's editor via the same store update
        }}
      >
        Add dimension
      </Button>
    </div>
  )
}

export function DimensionManager() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button>Dimensions</Button>
      </PopoverTrigger>
      {/* Esc order (SITEMAP §4): close the in-place editor first, the popover
          on the next press — never both at once. */}
      <PopoverContent align="start" sideOffset={4} onEscapeKeyDown={keepPopoverOpenWhileEditing}>
        <DimensionManagerPanel />
      </PopoverContent>
    </Popover>
  )
}
