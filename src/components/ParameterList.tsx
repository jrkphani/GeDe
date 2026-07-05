import { useEffect } from 'react'
import type { ParameterRow } from '../db/mutations'
import { useParametersStore } from '../store/parameters'
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
  return (
    <div className="param-row">
      <span className="param-row__index">{index + 1}</span>
      <InlineEdit
        value={param.name}
        onCommit={(next) => void rename(dimensionId, param.id, next)}
        display={param.name}
        displayClassName="param-row__name"
        selectOnFocus
        stopPropagation
      />
      <Button aria-label={`Remove ${param.name}`} onClick={() => void remove(dimensionId, param.id)}>
        Remove
      </Button>
    </div>
  )
}

// Nested inside each dimension's section of the manager popover (issue 003).
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
          onSubmit={(name) => void add(dimensionId, name)}
          stopPropagation
        />
      </div>
    </div>
  )
}
