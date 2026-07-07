import { useEffect } from 'react'
import { presenceCueLabel } from '../domain/presence'
import { useOnlinePresence, usePresenceStore } from '../store/presence'
import { useWorkspaceRole } from '../store/workspace'

// Issue 038 — the app-bar roster (SITEMAP §2 cluster, beside Share/Account):
// who else is currently in this project's workspace, excluding self. Owns
// starting/stopping the presence store for the open project's workspace
// (mirrors useWorkspaceRole's own load-on-change convention, src/store/
// workspace.ts) — no other surface needs to know presence is running.
// Renders nothing when there's nobody else here or presence is inert (v1's
// default, no-auth, or offline), same "no honest state to show" convention
// as src/shell/SyncIndicator.tsx.
function initials(label: string): string {
  const base = label.includes('@') ? (label.split('@')[0] ?? label) : label
  return base.slice(0, 2).toUpperCase() || '?'
}

export function PresenceRoster({ projectId }: { projectId: string }) {
  const { workspaceId } = useWorkspaceRole(projectId)
  const start = usePresenceStore((s) => s.start)
  const stop = usePresenceStore((s) => s.stop)
  const others = useOnlinePresence()

  useEffect(() => {
    if (!workspaceId) return
    start(workspaceId)
    return () => stop()
  }, [workspaceId, start, stop])

  if (others.length === 0) return null

  return (
    <div className="presence-roster" role="group" aria-label={presenceCueLabel(others, 'here')}>
      {others.map((entry) => (
        <span
          key={entry.userSub}
          className="presence-chip"
          style={{ background: entry.color }}
          title={entry.label}
        >
          {initials(entry.label)}
        </span>
      ))}
    </div>
  )
}
