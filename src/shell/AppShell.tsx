import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useCommandLogStore } from '../store/commandLog'
import { useCommandRegistryStore } from '../store/commandRegistry'
import { useProjectsStore } from '../store/projects'
import { useStatusStore } from '../store/status'
import { Button } from '../components/ui/button'
import { CommandPalette } from '../components/CommandPalette'
import { coreCommandSources } from './coreCommands'
import { navigate } from './router'
import { serializeRoute, type AppRoute, type Tier } from './routes'
import { ContextBarSlot } from './slots'
import { StatusBar } from './StatusBar'
import { toggleTheme } from './theme'

const UNDO_NARRATION_MS = 3000
const FRESH_SESSION_TOOLTIP = 'Undo history starts fresh each session'

// SITEMAP §2/§4, issue 006: the status bar narrates the step just undone/
// redone for 3s, then falls quiet again — distinct from the persistent
// inline-Undo pattern (archive) which waits for the user to act.
function narrate(message: string): void {
  useStatusStore.getState().announce(message)
  setTimeout(() => {
    if (useStatusStore.getState().message === message) useStatusStore.getState().clear()
  }, UNDO_NARRATION_MS)
}

function triggerUndo(): void {
  const { past, undo } = useCommandLogStore.getState()
  const label = past[past.length - 1]?.label
  if (!label) return
  void undo().then(() => narrate(`Undid: ${label}`))
}

function triggerRedo(): void {
  const { future, redo } = useCommandLogStore.getState()
  const label = future[future.length - 1]?.label
  if (!label) return
  void redo().then(() => narrate(`Redid: ${label}`))
}

// ⌘Z/⇧⌘Z falls through to the browser's native text-field undo when focus is
// inside an editable control *with something to revert* — the app's command
// log must not fight an in-progress edit a user is typing. But only while
// there's actual native undo history to defer to: committing a cell edit
// (Enter) moves focus to the next row, which is often the phantom row's
// empty input (Numbers-style grammar) — deferring there would silently
// swallow every ⌘Z pressed right after a commit, since an empty field has
// nothing for native undo to do.
function shouldDeferToNativeUndo(el: Element | null): boolean {
  if (el === null) return false
  if ((el as HTMLElement).isContentEditable) return true
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value.length > 0
  return false
}

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
  const past = useCommandLogStore((s) => s.past)
  const future = useCommandLogStore((s) => s.future)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // Captured at ⌘K press so a dismissal (Esc) can restore focus to exactly the
  // element the user left (SITEMAP §3); a navigation moves focus to the surface.
  const paletteOriginRef = useRef<HTMLElement | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)

  function closePalette(navigated: boolean) {
    setPaletteOpen(false)
    const origin = paletteOriginRef.current
    // rAF wins the race against Radix's own close-focus (cmdk's dialog has no
    // trigger to restore to, so it would otherwise drop focus to <body>).
    requestAnimationFrame(() => {
      if (navigated) surfaceRef.current?.focus()
      else origin?.focus()
    })
  }

  // The shell owns the palette's command sources (issue 016 seam): tier/canvas/
  // context navigation. Feature verbs register the same way, later. Registered
  // once on mount; the sources read live route/store state at collect time.
  useEffect(() => {
    const registry = useCommandRegistryStore.getState()
    const disposers = coreCommandSources().map((source) => registry.registerProvider(source))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, [])

  // Global keys (SITEMAP §4): ⌘1/⌘2/⌘3 switch tiers within a project; ⌘Z/⇧⌘Z
  // undo/redo everywhere (not gated on a project being open — e.g. the
  // projects-list archive lives here too). Skipped inside an editable field
  // so native text-undo still works there. Registered on the *capture* phase:
  // EditableGrid's phantom-row input calls stopPropagation() on every keydown
  // (to keep its own Enter/Escape/arrow grammar from leaking to ancestors),
  // which would otherwise swallow this bubble-phase listener whenever focus
  // is inside a phantom row — a real scenario, since committing a cell edit
  // moves focus to the next row, often the phantom one.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.code === 'KeyK') {
        e.preventDefault()
        paletteOriginRef.current = document.activeElement as HTMLElement | null
        setPaletteOpen(true)
        return
      }
      if (e.code === 'KeyZ') {
        if (shouldDeferToNativeUndo(document.activeElement)) return
        e.preventDefault()
        if (e.shiftKey) triggerRedo()
        else triggerUndo()
        return
      }
      if (projectId === null) return
      const tab = { Digit1: 'foundation', Digit2: 'architecture', Digit3: 'design' }[e.code] as
        | Tier
        | 'design'
        | undefined
      if (!tab) return
      e.preventDefault()
      navigate(routeForTab(projectId, tab))
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [projectId])

  // Session-scoped: the command log clears when the open project changes
  // (issue 006 design brief) — never carries stale cross-project commands.
  useEffect(() => {
    useCommandLogStore.getState().clear()
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
          <button
            className="row-action"
            aria-label="Command palette"
            title="Command palette (⌘K)"
            onClick={() => {
              paletteOriginRef.current = document.activeElement as HTMLElement | null
              setPaletteOpen(true)
            }}
          >
            ⌘K
          </button>
          <Button
            aria-label="Undo"
            disabled={past.length === 0}
            title={past.length > 0 ? `Undo: ${past[past.length - 1]?.label}` : FRESH_SESSION_TOOLTIP}
            onClick={triggerUndo}
          >
            ↶
          </Button>
          <Button
            aria-label="Redo"
            disabled={future.length === 0}
            title={future.length > 0 ? `Redo: ${future[future.length - 1]?.label}` : FRESH_SESSION_TOOLTIP}
            onClick={triggerRedo}
          >
            ↷
          </Button>
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
      <div className="surface" ref={surfaceRef} tabIndex={-1}>
        {children}
      </div>
      <StatusBar />
      <CommandPalette open={paletteOpen} onClose={closePalette} />
    </div>
  )
}
