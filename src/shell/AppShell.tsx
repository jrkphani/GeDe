import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useAuthStore } from '../store/auth'
import { useCommandLogStore } from '../store/commandLog'
import { useCommandRegistryStore } from '../store/commandRegistry'
import { useSemanticSearchStore } from '../store/semanticSearch'
import { useProjectsStore } from '../store/projects'
import { useStatusStore } from '../store/status'
import { useFocusedEditorStore } from '../store/focusedEditor'
import { Button } from '../components/ui/button'
import { FormatStrip } from '../components/FormatStrip'
import { Input } from '../components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover'
import { CommandPalette } from '../components/CommandPalette'
import { PendingInvitations } from '../components/PendingInvitations'
import { WorkspaceMembers } from '../components/WorkspaceMembers'
import { downloadTextFile, exportFilename } from '../lib/download'
import { coreCommandSources } from './coreCommands'
import { PresenceRoster } from './PresenceRoster'
import { navigate } from './router'
import { serializeRoute, type AppRoute, type Tier } from './routes'
import { ContextBar, ContextBarSlot } from './slots'
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

// A real, keyboard-native <button>/<input> pair (via the `ui/` primitives) —
// not `InlineEdit`, whose display state is a plain (non-focusable, click-only)
// <span> meant to live inside an already keyboard-handled row (F2/Enter, see
// ProjectsList). The app-bar rename control has no such wrapper, so it needs
// its own native focus/activation: a <Button> so Tab/Enter/Space still open
// the editor, matching the pre-migration raw <button>'s accessible behavior.
function ProjectName({ id }: { id: string }) {
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === id))
  const renameProject = useProjectsStore((s) => s.renameProject)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  if (!project) return null
  if (!editing) {
    return (
      <Button
        variant="bare"
        className="app-bar__project-name"
        title="Rename project"
        onClick={() => {
          setDraft(project.name)
          setEditing(true)
        }}
      >
        {project.name}
      </Button>
    )
  }
  return (
    <Input
      className="inplace-input app-bar__project-name-input"
      aria-label="Rename project"
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

// App-bar project menu (SITEMAP §2): owns "Export project…". Import lives on the
// projects list (issue 015 design brief). Export downloads immediately — no
// options screen — and narrates through the single status channel.
function ProjectMenu({ projectId }: { projectId: string }) {
  const exportProject = useProjectsStore((s) => s.exportProject)
  const announce = useStatusStore((s) => s.announce)
  const [open, setOpen] = useState(false)

  async function onExport() {
    setOpen(false)
    try {
      const { name, json } = await exportProject(projectId)
      downloadTextFile(exportFilename(name), json)
      announce(`Exported ${name}`)
    } catch (err) {
      announce(err instanceof Error ? err.message : 'Export failed')
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="rowAction" aria-label="Project menu" title="Project menu">
          ⋯
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="menu">
        <Button variant="bare" className="menu__item" onClick={() => void onExport()}>
          Export project…
        </Button>
      </PopoverContent>
    </Popover>
  )
}

// Account affordance (issue 033, SITEMAP §2 "App bar (stable everywhere)"):
// signed-out reads as a quiet, always-visible `command` CTA to /login;
// signed-in shows the identity + a sign-out popover. Composed entirely from
// `ui/` primitives — never a raw control, per the shell-wide lint (below).
function AccountMenu() {
  const status = useAuthStore((s) => s.status)
  const user = useAuthStore((s) => s.user)
  const signOut = useAuthStore((s) => s.signOut)
  const configured = useAuthStore((s) => s.configured)
  const [open, setOpen] = useState(false)

  if (status === 'authenticated' && user) {
    const label = user.email ?? user.sub
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="rowAction" aria-label={`Account: ${label}`} title={label} className="account-chip">
            {label}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="menu">
          <Button
            variant="bare"
            className="menu__item"
            onClick={() => {
              setOpen(false)
              // Issue 063 — clear-on-sign-out: signOut() itself wipes the
              // local PGlite (store/auth.ts); once that teardown settles,
              // redirect to the hero/login page (issue 064's canonical
              // signed-out on-ramp) rather than leaving the departed
              // session sitting on whatever project route was open.
              void signOut().then(() => navigate({ kind: 'login' }))
            }}
          >
            Sign out
          </Button>
        </PopoverContent>
      </Popover>
    )
  }

  if (!configured) return null

  return (
    <Button variant="command" onClick={() => navigate({ kind: 'login' })}>
      Sign in
    </Button>
  )
}

export function AppShell({ route, children }: { route: AppRoute; children: ReactNode }) {
  const projectId = projectIdOf(route)
  const active = activeTab(route)
  const past = useCommandLogStore((s) => s.past)
  const future = useCommandLogStore((s) => s.future)
  // 089 D1 P1 — the persistent rich-text FormatStrip is FOCUS-REVEALED: it fills
  // the context bar only while a rich editor is focused. This deliberately keeps
  // the existing collapse contract (slots.tsx: the band `hidden`s when its portal
  // count is 0) intact — an always-mounted strip would leave an empty chrome band
  // on every route. Selecting the boolean (not the editor) so the shell re-renders
  // only when focus enters/leaves a rich editor, not on every editor mutation.
  const formatStripActive = useFocusedEditorStore((s) => s.activeEditor !== null)
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

  // Issue 042: the shell owns triggering the semantic model's lazy load, on
  // the palette's first open — never `CommandPalette.tsx` itself (see that
  // file's header comment for why). `ensureModel` is idempotent and
  // fire-and-forget: a slow/failed/offline load never blocks opening the
  // palette, which stays fully lexical-functional either way.
  function openPalette() {
    paletteOriginRef.current = document.activeElement as HTMLElement | null
    setPaletteOpen(true)
    // Gated so e2e never triggers the ~45MB model fetch: the Playwright dev
    // server sets VITE_SEMANTIC_SEARCH=off, keeping the suite free of an
    // external-network dependency (the palette stays fully lexical). Any real
    // build leaves the flag unset, so production gets semantic search.
    if (import.meta.env.VITE_SEMANTIC_SEARCH !== 'off') {
      void useSemanticSearchStore.getState().ensureModel()
    }
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
        openPalette()
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
          <Button
            variant="rowAction"
            aria-label="Command palette"
            title="Command palette (⌘K)"
            onClick={openPalette}
          >
            ⌘K
          </Button>
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
          <Button variant="rowAction" aria-label="Toggle theme" onClick={() => toggleTheme()}>
            ◐
          </Button>
          {/* Export lives in the project menu (SITEMAP §2); import is on the
              projects list (issue 015). No menu without an open project.
              Share (issue 035) sits alongside — its own trigger self-hides
              outside a signed-in Cognito session (WorkspaceMembers). Presence
              (issue 038) is the quietest of the three — it self-hides
              whenever there's nobody else to show (PresenceRoster).
              Invitations (issue 060) is deliberately OUTSIDE the
              `projectId !== null` gates above: it's the invitee-facing
              counterpart to WorkspaceMembers' owner view, and a
              freshly-invited collaborator commonly has no project of their
              own open yet — it self-hides on its own (signed out / no
              pending invites), exactly like PresenceRoster/WorkspaceMembers. */}
          {projectId !== null && <PresenceRoster projectId={projectId} />}
          {projectId !== null && <WorkspaceMembers projectId={projectId} />}
          <PendingInvitations />
          {projectId !== null && <ProjectMenu projectId={projectId} />}
          <AccountMenu />
        </div>
      </header>
      <ContextBarSlot />
      {formatStripActive && (
        <ContextBar>
          <FormatStrip />
        </ContextBar>
      )}
      <div className="surface" ref={surfaceRef} tabIndex={-1}>
        {children}
      </div>
      <StatusBar />
      <CommandPalette open={paletteOpen} onClose={closePalette} />
    </div>
  )
}
