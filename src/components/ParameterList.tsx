import { useEffect, useRef, useState } from 'react'
import type { ParameterRow } from '../db/mutations'
import { useParametersStore } from '../store/parameters'

// Stable reference: a fresh `[]` fallback in the selector would compare
// unequal to itself every render and loop the store subscription forever.
const NO_PARAMETERS: ParameterRow[] = []

// Numbers-style phantom row grammar (STYLE_GUIDE §6, canonical here per issue
// 003): typing materializes the row; Enter commits + focuses a fresh phantom;
// Esc on an empty phantom is a no-op; Esc mid-edit reverts.

function ParameterName({ dimensionId, param }: { dimensionId: string; param: ParameterRow }) {
  const rename = useParametersStore((s) => s.rename)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(param.name)

  if (!editing) {
    return (
      <span
        className="param-row__name"
        onClick={() => {
          setDraft(param.name)
          setEditing(true)
        }}
      >
        {param.name}
      </span>
    )
  }
  return (
    <input
      className="inplace-input"
      value={draft}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          const next = draft.trim()
          if (next && next !== param.name) void rename(dimensionId, param.id, next)
          setEditing(false)
        }
        if (e.key === 'Escape') setEditing(false)
      }}
    />
  )
}

function ParameterRowView({
  dimensionId,
  param,
  index,
}: {
  dimensionId: string
  param: ParameterRow
  index: number
}) {
  const remove = useParametersStore((s) => s.remove)
  return (
    <div className="param-row">
      <span className="param-row__index">{index + 1}</span>
      <ParameterName dimensionId={dimensionId} param={param} />
      <button
        className="row-action"
        aria-label={`Remove ${param.name}`}
        onClick={() => void remove(dimensionId, param.id)}
      >
        Remove
      </button>
    </div>
  )
}

function PhantomParameterRow({ dimensionId }: { dimensionId: string }) {
  const add = useParametersStore((s) => s.add)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <div className="param-row param-row--phantom">
      <input
        ref={inputRef}
        className="inplace-input"
        placeholder="Type to add a parameter"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && draft.trim()) {
            void add(dimensionId, draft.trim())
            setDraft('')
            inputRef.current?.focus()
          }
          if (e.key === 'Escape') setDraft('')
        }}
      />
    </div>
  )
}

// Nested inside each dimension's section of the manager popover (issue 003).
export function ParameterList({ dimensionId }: { dimensionId: string }) {
  const params = useParametersStore((s) => s.byDimension[dimensionId] ?? NO_PARAMETERS)
  const load = useParametersStore((s) => s.load)

  useEffect(() => {
    void load(dimensionId)
  }, [dimensionId, load])

  return (
    <div className="param-list">
      {params.map((p, i) => (
        <ParameterRowView key={p.id} dimensionId={dimensionId} param={p} index={i} />
      ))}
      <PhantomParameterRow dimensionId={dimensionId} />
    </div>
  )
}
