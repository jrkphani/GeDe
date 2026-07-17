import { useState } from 'react'
import { ChevronDown, Pencil } from 'lucide-react'
import { navigate } from '../shell/router'
import type { DesignView } from '../shell/routes'
import { useCanvasesStore } from '../store/canvases'
import type { CanvasRow } from '../db/mutations'
import { Button } from './ui/button'
import { InlineEdit, PhantomInput } from './ui/inline-editor'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

// Issue 090 Phase 4c — the root-canvas switcher. Lives in the Design context
// bar's `context-bar__location` group and only at depth 0 (contextPath empty);
// at depth>0 the breadcrumb owns navigation and the open canvas is pinned by
// the context chain. Mirrors ProjectsList's row idiom (rowAction rename/delete
// + a phantom "type to create" row) so the visual language stays consistent —
// no new primitives invented.

// A root canvas's display label: its user-given name, or an ordinal fallback
// ("Canvas 1/2/3") when name is NULL (Open Question 1 — child canvases derive
// from the context symbol, root canvases are ordinal until named).
export function canvasLabel(canvas: Pick<CanvasRow, 'name'>, index: number): string {
  const trimmed = canvas.name?.trim()
  if (trimmed) return trimmed
  return `Canvas ${index + 1}`
}

export function CanvasSwitcher({
  projectId,
  view,
  currentCanvasId,
}: {
  projectId: string
  view: DesignView
  currentCanvasId: string | null
}) {
  const canvases = useCanvasesStore((s) => s.canvases)
  const create = useCanvasesStore((s) => s.create)
  const rename = useCanvasesStore((s) => s.rename)
  const archive = useCanvasesStore((s) => s.archive)
  const select = useCanvasesStore((s) => s.select)
  const [open, setOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)

  const currentIndex = canvases.findIndex((c) => c.id === currentCanvasId)
  const current = currentIndex >= 0 ? canvases[currentIndex] : canvases[0]
  const currentLabel = current ? canvasLabel(current, currentIndex >= 0 ? currentIndex : 0) : 'Canvas'

  function goTo(id: string) {
    select(id)
    navigate({ kind: 'design', projectId, contextPath: [], view, canvasId: id })
    setOpen(false)
  }

  // The switcher writes the URL through navigate() (single source of truth for
  // the active canvas), then closes the popover.
  function createCanvas(name: string): Promise<void> {
    return create(name).then((row) => {
      if (row) {
        navigate({ kind: 'design', projectId, contextPath: [], view, canvasId: row.id })
        setOpen(false)
      }
    })
  }

  // archive() already floor-guards (RootCanvasFloorError → status narration,
  // no-op) and announces the delete with an inline Undo. If the CURRENT canvas
  // was the one deleted, follow the store's new selection so the URL doesn't
  // strand on a tombstoned id.
  async function deleteCanvas(id: string) {
    await archive(id)
    if (id === currentCanvasId) {
      const next = useCanvasesStore.getState().selectedCanvasId
      if (next) navigate({ kind: 'design', projectId, contextPath: [], view, canvasId: next })
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="bare"
          className="canvas-switcher__trigger"
          aria-label={`Canvas: ${currentLabel}`}
        >
          <span className="canvas-switcher__current">{currentLabel}</span>
          <ChevronDown className="canvas-switcher__chevron" size={14} aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="canvas-switcher__menu" align="start">
        <div role="listbox" aria-label="Design canvases" className="canvas-switcher__list">
          {canvases.map((canvas, index) => {
            const label = canvasLabel(canvas, index)
            const selected = canvas.id === current?.id
            const renaming = renamingId === canvas.id
            return (
              <div
                key={canvas.id}
                role="option"
                aria-selected={selected}
                tabIndex={0}
                className={
                  selected ? 'canvas-switcher__row canvas-switcher__row--selected' : 'canvas-switcher__row'
                }
                onClick={() => {
                  if (!renaming) goTo(canvas.id)
                }}
                onKeyDown={(e) => {
                  if (e.currentTarget !== e.target) return
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    goTo(canvas.id)
                  }
                }}
              >
                {renaming ? (
                  <InlineEdit
                    value={canvas.name ?? label}
                    onCommit={(next) => void rename(canvas.id, next)}
                    display={label}
                    displayClassName="canvas-switcher__name"
                    ariaLabel={`Rename ${label}`}
                    stopPropagation
                    selectOnFocus
                    editing
                    onEditingChange={(next) => setRenamingId(next ? canvas.id : null)}
                  />
                ) : (
                  <span className="canvas-switcher__name">{label}</span>
                )}
                {!renaming && (
                  <Button
                    variant="rowAction"
                    aria-label={`Rename ${label}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      setRenamingId(canvas.id)
                    }}
                  >
                    <Pencil size={13} aria-hidden="true" />
                  </Button>
                )}
                <Button
                  variant="rowAction"
                  aria-label={`Delete ${label}`}
                  // The last live root canvas can't be deleted (SPEC floor); the
                  // store enforces it too, but disabling here avoids a no-op.
                  disabled={canvases.length <= 1}
                  onClick={(e) => {
                    e.stopPropagation()
                    void deleteCanvas(canvas.id)
                  }}
                >
                  Delete
                </Button>
              </div>
            )
          })}
          <div className="canvas-switcher__row canvas-switcher__row--phantom">
            <PhantomInput
              placeholder="Type to add a canvas"
              ariaLabel="Add a canvas"
              // Returned (not fire-and-forget) so PhantomInput's re-entrancy
              // guard (issue 069) awaits it and ignores a double-Enter.
              onSubmit={createCanvas}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
