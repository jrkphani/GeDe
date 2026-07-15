import { Link2 } from 'lucide-react'
import { useEffect } from 'react'
import type { ParameterRow } from '../db/mutations'
import { useParametersStore } from '../store/parameters'
import { useTier2Store } from '../store/tier2'
import { Button } from './ui/button'
import { InlineEdit, PhantomInput } from './ui/inline-editor'

// Stable reference: a fresh `[]` fallback in the selector would compare
// unequal to itself every render and loop the store subscription forever.
const NO_PARAMETERS: ParameterRow[] = []

// Numbers-style phantom row grammar (STYLE_GUIDE §6, canonical here per issue
// 003): typing materializes the row; Enter commits + focuses a fresh phantom;
// Esc on an empty phantom is a no-op; Esc mid-edit reverts. The grammar now
// lives in the ui/ inline-edit primitives (issue 019).

function ParameterRowView({
  dimensionId,
  param,
  index,
}: {
  dimensionId: string
  param: ParameterRow
  index: number
}) {
  const rename = useParametersStore((s) => s.rename)
  const remove = useParametersStore((s) => s.remove)
  // Both sides of the tier link stay visible (invariant 7, issue 014): a
  // promoted parameter shows a link glyph whose tooltip names its 2nd-Tier
  // source entry (the entry carries the mirrored `→ Dim` badge).
  const sourceEntryName = useTier2Store((s) => {
    if (!param.sourceEntryId) return undefined
    for (const list of Object.values(s.entriesByTable)) {
      const hit = list.find((e) => e.id === param.sourceEntryId)
      if (hit) return hit.name
    }
    return undefined
  })
  return (
    <div className="param-row">
      <span className="param-row__index">{index + 1}</span>
      <InlineEdit
        chainId={`param:${dimensionId}:${param.id}`}
        value={param.name}
        onCommit={(next) => void rename(dimensionId, param.id, next)}
        display={param.name}
        displayClassName="param-row__name"
        selectOnFocus
        stopPropagation
      />
      {param.sourceEntryId && (
        <span
          className="param-row__source"
          title={sourceEntryName ? `Linked from ${sourceEntryName}` : 'Linked from an architecture entry'}
          aria-label={sourceEntryName ? `Linked from ${sourceEntryName}` : 'Linked from an architecture entry'}
        >
          <Link2 size={14} />
        </span>
      )}
      {/* Issue 082 Phase 1 polish — a per-row destructive action is the
          `rowAction` variant (STYLE_GUIDE §2.2/§6: quiet until the row is
          hovered/focused), not `command` (always-visible, reserved for
          standalone actions like the dimension rail's own phantom). This
          previously competed with the parameter name at full weight on
          every row. */}
      <Button
        aria-label={`Remove ${param.name}`}
        onClick={() => void remove(dimensionId, param.id)}
      >
        Remove
      </Button>
    </div>
  )
}

// Nested inside each dimension's section of the dimension rail (issue 003;
// the rail replaced the popover it used to live in — issue 082 Phase 1).
export function ParameterList({ dimensionId }: { dimensionId: string }) {
  const params = useParametersStore((s) => s.byDimension[dimensionId] ?? NO_PARAMETERS)
  const load = useParametersStore((s) => s.load)
  const add = useParametersStore((s) => s.add)

  useEffect(() => {
    void load(dimensionId)
  }, [dimensionId, load])

  return (
    <div className="param-list">
      {params.map((p, i) => (
        <ParameterRowView key={p.id} dimensionId={dimensionId} param={p} index={i} />
      ))}
      <div className="param-row param-row--phantom">
        <PhantomInput
          placeholder="Type to add a parameter"
          chainId={`paramPhantom:${dimensionId}`}
          onSubmit={(name) => void add(dimensionId, name)}
          stopPropagation
        />
      </div>
    </div>
  )
}
