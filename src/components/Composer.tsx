import { tupleReadout } from '../domain/contextDescription'
import { MultilineEdit } from './ui/multiline-editor'
import { Swatch } from './ui/swatch'
import type { ContextRow, DimensionRow } from '../db/mutations'

// Issue 009 — read-mode composer bar (SPEC §4.2/§4.4; the full compose/bind
// gesture with parameter pickers is issue 010). Presentational, like
// `Canvas`: DesignSurface looks up the selected ContextRow and passes it
// down, rather than this component reading the store itself.
export interface ComposerProps {
  dimensions: readonly DimensionRow[]
  selected: ContextRow | null
  bindings: Readonly<Record<string, string>>
  paramNameById: Readonly<Record<string, string>>
  onJustificationCommit: (value: string) => void
}

export function Composer({ dimensions, selected, bindings, paramNameById, onJustificationCommit }: ComposerProps) {
  if (!selected) return null

  const tuple = tupleReadout(dimensions, bindings, paramNameById)
  const justification = selected.justification ?? ''
  const justificationDisplay = justification.trim() === '' ? 'Add a justification…' : justification

  return (
    <div className="composer-bar">
      <div className="composer-legend">
        {dimensions.map((dim, i) => (
          <span key={dim.id} className="composer-legend__item">
            <Swatch color={dim.color} className="composer-legend__swatch" />
            <span className="composer-legend__dimension">{dim.name}</span>
            <span className="composer-legend__parameter">{tuple[i]}</span>
          </span>
        ))}
      </div>
      <div className="composer-tuple">{tuple.map((v) => `{${v}}`).join(' ')}</div>
      <MultilineEdit
        value={justification}
        onCommit={onJustificationCommit}
        display={justificationDisplay}
        displayClassName="composer-justification"
        inputClassName="composer-justification__input"
        ariaLabel={`Justification for ${selected.symbol}`}
      />
    </div>
  )
}
