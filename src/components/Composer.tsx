import { cn } from '@/lib/utils'
import { tupleReadout } from '../domain/contextDescription'
import { Button } from './ui/button'
import { Combobox } from './ui/combobox'
import { MultilineEdit } from './ui/multiline-editor'
import { Swatch } from './ui/swatch'
import type { ContextRow, DimensionRow, ParameterRow } from '../db/mutations'

// Issue 009 gave the composer bar its read-mode projection (legend + tuple +
// justification). Issue 010 adds edit/compose mode: one parameter picker per
// dimension (sharing the register's combobox via ui/combobox — not a fork),
// the active dimension highlighted, and a live non-blocking duplicate badge.
// Still presentational like `Canvas`: DesignSurface owns the store writes and
// passes the pending tuple's duplicate siblings in.
export interface ComposerProps {
  dimensions: readonly DimensionRow[]
  selected: ContextRow | null
  bindings: Readonly<Record<string, string>>
  paramNameById: Readonly<Record<string, string>>
  onJustificationCommit: (value: string) => void
  // Compose/edit mode (issue 010). When `composing`, per-dimension pickers
  // render; all optional so read-mode callers (a plain selection) are unchanged.
  composing?: boolean
  activeDimensionId?: string | null
  parametersByDimension?: Readonly<Record<string, readonly ParameterRow[]>>
  onBindParameter?: (dimensionId: string, parameterId: string) => void
  onUnbindParameter?: (dimensionId: string) => void
  duplicateSiblingSymbols?: readonly string[]
}

export function Composer({
  dimensions,
  selected,
  bindings,
  paramNameById,
  onJustificationCommit,
  composing = false,
  activeDimensionId = null,
  parametersByDimension = {},
  onBindParameter,
  onUnbindParameter,
  duplicateSiblingSymbols = [],
}: ComposerProps) {
  if (!selected) return null

  const tuple = tupleReadout(dimensions, bindings, paramNameById)
  const justification = selected.justification ?? ''
  const justificationDisplay = justification.trim() === '' ? 'Add a justification…' : justification

  return (
    <div className="composer-bar" data-composing={composing}>
      {composing ? (
        <div className="composer-pickers">
          {dimensions.map((dim) => {
            const value = bindings[dim.id] ?? null
            const boundName = value ? (paramNameById[value] ?? null) : null
            return (
              <Combobox
                key={dim.id}
                value={value}
                options={(parametersByDimension[dim.id] ?? []).map((p) => ({
                  value: p.id,
                  label: p.name,
                  color: dim.color,
                }))}
                onChange={(next) => {
                  if (next) onBindParameter?.(dim.id, next)
                  else onUnbindParameter?.(dim.id)
                }}
                trigger={
                  <Button
                    variant="bare"
                    className={cn('composer-picker', {
                      'composer-picker--active': dim.id === activeDimensionId,
                    })}
                  >
                    <span className="composer-picker__dimension">
                      <Swatch color={dim.color} />
                      {dim.name}
                    </span>
                    <span className="composer-picker__value">
                      {boundName ?? <span className="grid-cell__placeholder">—</span>}
                    </span>
                  </Button>
                }
              />
            )
          })}
        </div>
      ) : (
        <div className="composer-legend">
          {dimensions.map((dim, i) => (
            <span key={dim.id} className="composer-legend__item">
              <Swatch color={dim.color} className="composer-legend__swatch" />
              <span className="composer-legend__dimension">{dim.name}</span>
              <span className="composer-legend__parameter">{tuple[i]}</span>
            </span>
          ))}
        </div>
      )}

      <div className="composer-tuple-row">
        <div className="composer-tuple">{tuple.map((v) => `{${v}}`).join(' ')}</div>
        {duplicateSiblingSymbols.length > 0 ? (
          <span
            className="composer-duplicate"
            title={`Same tuple as ${duplicateSiblingSymbols.join(', ')}`}
          >
            = {duplicateSiblingSymbols.join(', ')}
          </span>
        ) : null}
      </div>

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
