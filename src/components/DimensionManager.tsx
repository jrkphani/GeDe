import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useState } from 'react'
import type { DimensionRow } from '../db/mutations'
import { computeRemovalImpact } from '../domain/dimensionImpact'
import { useContextsStore } from '../store/contexts'
import { useDimensionsStore } from '../store/dimensions'
import { useParametersStore } from '../store/parameters'
import { DIMENSION_PALETTE } from '../theme/palette'
import { ParameterList } from './ParameterList'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { EditableChainProvider, InlineEdit, PhantomInput, useEditableChain } from './ui/inline-editor'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
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
      <PopoverContent align="start" sideOffset={4}>
        <p className="remove-dimension-confirm__copy">
          Remove <strong>{dimension.name}</strong>? Deletes{' '}
          <span className="font-mono">{bindingCount}</span>{' '}
          {bindingCount === 1 ? 'binding' : 'bindings'}.
        </p>
        <div className="remove-dimension-confirm__actions">
          <Button variant="command" onClick={() => setOpen(false)}>
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
  childCanvas = false,
}: {
  dimension: DimensionRow
  index: number
  editing: boolean
  setEditing: (id: string | null) => void
  canRemove: boolean
  // On a child canvas the dimensions are DERIVED from the parent's bindings
  // (issue 011): the name tracks the source parameter and there is no
  // add/remove/reorder — only the nested sub-parameter list is editable.
  childCanvas?: boolean
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
          if (childCanvas) return
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
        {childCanvas ? null : (
          <Button
            variant="bare"
            className="drag-handle"
            aria-label={`Reorder ${dimension.name}`}
            {...attributes}
            {...listeners}
          >
            ⋮⋮
          </Button>
        )}
        <SwatchButton
          color={dimension.color}
          aria-label={`Color of ${dimension.name}`}
          onClick={() => setPicking(!picking)}
        />
        {childCanvas ? (
          <span className="dim-row__name dim-row__name--head" title="Refines the parent’s bound parameter">
            {dimension.name}
          </span>
        ) : (
          <InlineEdit
            chainId={`dim:${dimension.id}`}
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
        )}
        {childCanvas ? null : <RemoveDimensionConfirm dimension={dimension} canRemove={canRemove} />}
        {picking && <SwatchPicker dimension={dimension} onDone={() => setPicking(false)} />}
      </div>
      <ParameterList dimensionId={dimension.id} />
    </div>
  )
}

// Issue 082 Phase 1 — unifies the third add grammar onto the same phantom-row
// pattern parameters/contexts already use (STYLE_GUIDE §6 "New row = start
// typing in the phantom row"): replaces the old "Add dimension" command
// button. A separate component (rather than inline JSX in
// DimensionManagerPanel) because it needs `useEditableChain()`, which only
// resolves for descendants of the `<EditableChainProvider>` panel renders —
// not the panel's own top-level scope.
function DimensionAddPhantom() {
  const add = useDimensionsStore((s) => s.add)
  const chain = useEditableChain()
  return (
    <div className="dim-manager__add-phantom">
      <PhantomInput
        placeholder="Type to add a dimension"
        ariaLabel="Add dimension"
        chainId="dimPhantom"
        onSubmit={(name) => {
          void add(name)
        }}
        // Tab-with-content (Numbers/Excel "continue into the new row"): the
        // freshly created dimension's own successor in the chain is ITS
        // parameter phantom (dimension -> its params -> next dimension), so
        // Tab here starts the new dimension's parameter list instead of
        // re-focusing this same phantom the way Enter does.
        onTabSubmit={(name) => {
          void add(name).then((row) => {
            if (row) chain?.focusWhenReady(`paramPhantom:${row.id}`)
          })
        }}
      />
    </div>
  )
}

// Exported for direct testing and as the always-open rail panel (issue 082
// Phase 1 — replaces the guided-start bifurcation, issue 002).
export function DimensionManagerPanel({ childCanvas = false }: { childCanvas?: boolean }) {
  const dimensions = useDimensionsStore((s) => s.dimensions)
  const reorder = useDimensionsStore((s) => s.reorder)
  const editingId = useDimensionsStore((s) => s.editingId)
  const setEditingId = useDimensionsStore((s) => s.setEditing)
  const paramsByDimension = useParametersStore((s) => s.byDimension)
  const canRemove = dimensions.length > 2

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const toIndex = dimensions.findIndex((d) => d.id === over.id)
    if (toIndex >= 0) void reorder(String(active.id), toIndex)
  }

  // Issue 082 Phase 1 — the rail's full keyboard chain: dimension name -> its
  // parameter names -> its own "type to add a parameter" phantom -> the next
  // dimension -> ... -> the dimension-add phantom. Recomputed every render
  // from live store state (EditableChainProvider's own contract), so a
  // created/removed row is always reachable without extra wiring. A child
  // canvas's dimension names aren't part of the chain at all (they're a
  // plain, non-editable span — only sub-parameters are edited there).
  const order = dimensions.flatMap((d) => [
    ...(childCanvas ? [] : [`dim:${d.id}`]),
    ...(paramsByDimension[d.id] ?? []).map((p) => `param:${d.id}:${p.id}`),
    `paramPhantom:${d.id}`,
  ])
  if (!childCanvas) order.push('dimPhantom')

  return (
    <EditableChainProvider order={order}>
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
                childCanvas={childCanvas}
              />
            ))}
          </SortableContext>
        </DndContext>
        {/* Child-canvas dimensions are derived from the parent's bindings, not
            freely added (SPEC recursion rule) — only sub-parameters are edited. */}
        {childCanvas ? null : <DimensionAddPhantom />}
      </div>
    </EditableChainProvider>
  )
}
