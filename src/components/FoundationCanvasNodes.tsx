import { useTier1Store } from '../store/tier1'
import { FoundationValueTable } from './FoundationSurface'
import { RichTextEditor } from './ui/rich-text-editor'

// Foundation-lane canvas adapter. Purpose, Existing Scenario and the shared
// multi-row value-proposition table live in one React Flow node. This preserves
// the fallback Foundation surface's spreadsheet grammar instead of fragmenting
// every proposition into a separate one-row table/node.

const PURPOSE_GHOST = 'What is this system for?'
const EXISTING_SCENARIO_GHOST = 'Describe the existing scenario…'

export function FoundationHeaderPanel({
  readOnly,
  tableCollapsed,
}: {
  readOnly: boolean
  tableCollapsed: boolean
}) {
  const purpose = useTier1Store((s) => s.purpose)
  const existingScenario = useTier1Store((s) => s.existingScenario)
  const setPurpose = useTier1Store((s) => s.setPurpose)
  const setExistingScenario = useTier1Store((s) => s.setExistingScenario)

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

      <FoundationValueTable readOnly={readOnly} collapsed={tableCollapsed} />
    </div>
  )
}
