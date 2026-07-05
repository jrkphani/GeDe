import { useEffect, useState, type ReactNode } from 'react'
import { useProjectsStore } from '../store/projects'
import { navigate } from './router'
import { serializeRoute, type AppRoute, type Tier } from './routes'
import { ContextBarSlot } from './slots'
import { StatusBar } from './StatusBar'
import { toggleTheme } from './theme'

const TIER_TABS: { key: Tier | 'design'; label: string }[] = [
  { key: 'foundation', label: 'Foundation' },
  { key: 'architecture', label: 'Architecture' },
  { key: 'design', label: 'Design' },
]

function routeForTab(projectId: string, tab: Tier | 'design'): AppRoute {
  return tab === 'design'
    ? { kind: 'design', projectId, contextPath: [], view: 'canvas' }
    : { kind: 'tier', projectId, tier: tab }
}

function activeTab(route: AppRoute): Tier | 'design' | null {
  if (route.kind === 'tier') return route.tier
  if (route.kind === 'design') return 'design'
  return null
}

function projectIdOf(route: AppRoute): string | null {
  return route.kind === 'tier' || route.kind === 'design' || route.kind === 'project'
    ? route.projectId
    : null
}

function ProjectName({ id }: { id: string }) {
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === id))
  const renameProject = useProjectsStore((s) => s.renameProject)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  if (!project) return null
  if (!editing) {
    return (
      <button
        className="app-bar__project-name"
        title="Rename project"
        onClick={() => {
          setDraft(project.name)
          setEditing(true)
        }}
      >
        {project.name}
      </button>
    )
  }
  return (
    <input
      className="inplace-input app-bar__project-name-input"
      value={draft}
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          const next = draft.trim()
          if (next && next !== project.name) void renameProject(id, next)
          setEditing(false)
        }
        if (e.key === 'Escape') setEditing(false)
      }}
    />
  )
}

export function AppShell({ route, children }: { route: AppRoute; children: ReactNode }) {
  const projectId = projectIdOf(route)
  const active = activeTab(route)

  // Global keys (SITEMAP §4): ⌘1/⌘2/⌘3 switch tiers within a project.
  useEffect(() => {
    if (projectId === null) return
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || projectId === null) return
      const tab = { Digit1: 'foundation', Digit2: 'architecture', Digit3: 'design' }[e.code] as
        | Tier
        | 'design'
        | undefined
      if (!tab) return
      e.preventDefault()
      navigate(routeForTab(projectId, tab))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [projectId])

  return (
    <div className="shell">
      <header className="app-bar">
        <h1 className="wordmark">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault()
              navigate({ kind: 'projects' })
            }}
          >
            GeDe
          </a>
        </h1>
        {projectId !== null && <ProjectName id={projectId} />}
        {projectId !== null && (
          <nav className="tabs" aria-label="Tiers">
            {TIER_TABS.map((tab) => (
              <a
                key={tab.key}
                href={serializeRoute(routeForTab(projectId, tab.key))}
                className={active === tab.key ? 'tab tab--active' : 'tab'}
                aria-current={active === tab.key ? 'page' : undefined}
                onClick={(e) => {
                  e.preventDefault()
                  navigate(routeForTab(projectId, tab.key))
                }}
              >
                {tab.label}
              </a>
            ))}
          </nav>
        )}
        <div className="app-bar__cluster">
          {/* Undo/redo are wired by the command log (issue 006). */}
          <button className="row-action" aria-label="Undo" disabled title="Undo arrives with the command log">
            ↶
          </button>
          <button className="row-action" aria-label="Redo" disabled title="Redo arrives with the command log">
            ↷
          </button>
          <button className="row-action" aria-label="Toggle theme" onClick={() => toggleTheme()}>
            ◐
          </button>
          {/* Export/Import land here in issue 015. */}
          <button className="row-action" aria-label="Project menu" disabled title="Project menu arrives with export/import">
            ⋯
          </button>
        </div>
      </header>
      <ContextBarSlot />
      <div className="surface">{children}</div>
      <StatusBar />
    </div>
  )
}
