import type { Tier1PropRow } from '../db/mutations'
import { useTier1Store } from '../store/tier1'
import { EditableGrid, type GridColumn } from './EditableGrid'
import { PhantomInput } from './ui/inline-editor'
import { RichTextEditor } from './ui/rich-text-editor'

// 089-D3 graduation P1 — Foundation-lane decomposition adapter. On the `?d3rf`
// canvas the Foundation lane is no longer one whole-surface node; it splits into
// a HEADER node (Purpose + Existing-Scenario rich editors + the add-prop phantom)
// and one ITEM node PER `tier1_props` value-prop (its name/description grid). The
// non-canvas app still renders the whole `FoundationSurface`, so these are a NEW
// adapter (mirroring how the Architecture column reuses the exported `TablePanel`)
// rather than surgery on `FoundationSurface` — the two coexist and share the one
// `useTier1Store`. The rank/degree is shown on the node handle (WorkspaceCanvas),
// so an item panel is just the name/description columns; drag-reorder →
// `reorderProp` lives on the canvas (parallel to Architecture's `reorderTable`).

const PURPOSE_GHOST = 'What is this system for?'
const EXISTING_SCENARIO_GHOST = 'Describe the existing scenario…'

// The header node's body: the tier heading, the Purpose + Existing-Scenario rich
// editors (identical contract to FoundationSurface), and the single add-prop
// phantom (the one create path — parallel to Architecture's add-table phantom).
// The canvas owns `load(projectId)`, so this only subscribes to the fields it
// renders. `onPropCreated` continues focus into the freshly-mounted item node.
export function FoundationHeaderPanel({
  readOnly,
  onPropCreated,
}: {
  readOnly: boolean
  onPropCreated: (propId: string) => void
}) {
  const purpose = useTier1Store((s) => s.purpose)
  const existingScenario = useTier1Store((s) => s.existingScenario)
  const setPurpose = useTier1Store((s) => s.setPurpose)
  const setExistingScenario = useTier1Store((s) => s.setExistingScenario)
  const addProp = useTier1Store((s) => s.addProp)

  return (
    <div className="foundation foundation--canvas-header">
      <h2 className="tier1-header">1st Tier · Foundation</h2>

      <section className="panel tier1-purpose">
        <RichTextEditor
          value={purpose || null}
          onCommit={(next) => void setPurpose(next ?? '')}
          ariaLabel="System purpose"
          placeholder={PURPOSE_GHOST}
          namespace="gede-tier1-purpose"
          readOnly={readOnly}
        />
      </section>

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

      {readOnly ? null : (
        <div className="tier1-add-prop">
          <span className="tier1-add-prop__glyph" aria-hidden>
            +
          </span>
          <PhantomInput
            placeholder="Name a value proposition"
            ariaLabel="Add value proposition"
            inputClassName="tier1-add-prop__input"
            onSubmit={(name) =>
              void addProp(name).then((row) => {
                if (row) onPropCreated(row.id)
              })
            }
          />
        </div>
      )}
    </div>
  )
}

// A single value-prop's editable name + description, as one EditableGrid row.
// The rank/degree is rendered on the enclosing node's handle, so it is NOT a
// column here (unlike whole-surface FoundationSurface). `onExitBoundary` wires
// the grid's frozen Tab-off-a-boundary seam to the canvas's cross-node traversal
// (name↔description within the row, then off the ends to the prev/next prop node).
export function FoundationPropPanel({
  prop,
  readOnly,
  onExitBoundary,
}: {
  prop: Tier1PropRow
  readOnly: boolean
  onExitBoundary?: ((dir: 'forward' | 'backward') => void) | undefined
}) {
  const renameProp = useTier1Store((s) => s.renameProp)
  const setDescription = useTier1Store((s) => s.setDescription)

  const columns: GridColumn<Tier1PropRow>[] = [
    {
      id: 'name',
      header: 'Name',
      cell: {
        kind: 'text',
        getValue: (p) => p.name,
        onCommit: async (p, value) => {
          // Never let a cleared name orphan a row (no name-delete affordance
          // here); an empty commit is a no-op revert — identical to FoundationSurface.
          if (value.length > 0 && value !== p.name) await renameProp(p.id, value)
          return value.length > 0
        },
      },
    },
    {
      id: 'description',
      header: 'Description',
      cell: {
        kind: 'richtext',
        placeholder: 'Add description…',
        getValue: (p) => p.description ?? '',
        onCommit: async (p, value) => {
          await setDescription(p.id, value)
          return true
        },
      },
    },
  ]

  return (
    <EditableGrid
      rows={[prop]}
      columns={columns}
      getRowId={(p) => p.id}
      readOnly={readOnly}
      // Conditional spread (not `onExitBoundary={onExitBoundary}`) so the prop is
      // absent when undefined — EditableGridProps' optional isn't `| undefined`
      // under exactOptionalPropertyTypes (same pattern as TablePanel).
      {...(onExitBoundary ? { onExitBoundary } : {})}
    />
  )
}
