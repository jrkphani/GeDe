import { useState } from 'react'
import type { ProjectRow } from '../db/mutations'
import { useAuthStore } from '../store/auth'
import { useProjectsStore } from '../store/projects'
import { useStatusStore } from '../store/status'
import { Button } from './ui/button'
import { Combobox, type ComboboxOption } from './ui/combobox'

// Issue 037 (the local→cloud on-ramp, STYLE_GUIDE §9) — "Move to
// workspace…" on a local project's row, from the (signed-in) projects list.
// Account-gated exactly like WorkspaceMembers (issue 035): moving a project
// into a workspace is meaningless without a real Cognito identity to own
// that workspace, so this renders nothing in local/solo mode. Once a project
// is adopted (adoptedIntoProjectId set), the gesture retires into a quiet,
// static label — the calm, no-modal confirmation the design brief asks for
// lives in the status bar (announce), not here.
export function AdoptProjectButton({ project }: { project: ProjectRow }) {
  const configured = useAuthStore((s) => s.configured)
  const status = useAuthStore((s) => s.status)
  const adoptProject = useProjectsStore((s) => s.adoptProject)
  const listWorkspaceOptions = useProjectsStore((s) => s.listWorkspaceOptions)
  const announce = useStatusStore((s) => s.announce)

  const [options, setOptions] = useState<ComboboxOption[] | null>(null)
  const [busy, setBusy] = useState(false)

  if (!configured || status !== 'authenticated') return null

  if (project.adoptedIntoProjectId !== null) {
    return (
      <span className="project-adopted" aria-label={`${project.name} is already in a workspace`}>
        In workspace
      </span>
    )
  }

  async function loadOptions() {
    try {
      const workspaces = await listWorkspaceOptions()
      setOptions(workspaces.map((w) => ({ value: w.id, label: w.name })))
    } catch (err) {
      announce(err instanceof Error ? err.message : 'Could not list workspaces')
      setOptions([])
    }
  }

  async function onChoose(workspaceId: string | null) {
    if (workspaceId === null || busy) return
    setBusy(true)
    try {
      const { alreadyAdopted } = await adoptProject(project.id, workspaceId)
      announce(
        alreadyAdopted
          ? `“${project.name}” is already in that workspace`
          : `Moved “${project.name}” to your workspace — it will sync from here on`,
      )
    } catch (err) {
      announce(err instanceof Error ? err.message : 'Could not move this project')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Combobox
      value={null}
      options={options ?? []}
      onChange={(v) => void onChoose(v)}
      onOpenChange={(open) => {
        if (open && options === null) void loadOptions()
      }}
      filterPlaceholder="Choose a workspace…"
      trigger={
        <Button
          variant="rowAction"
          aria-label={`Move ${project.name} to workspace`}
          title="Move to workspace"
          disabled={busy}
          onClick={(e) => e.stopPropagation()}
        >
          Move to workspace…
        </Button>
      }
    />
  )
}
