import { useEffect, useRef, useState } from 'react'
import { ChevronRight, Pencil } from 'lucide-react'
import { useCommandLogStore } from '../store/commandLog'
import { useProjectsStore } from '../store/projects'
import { useStatusStore } from '../store/status'
import { AdoptProjectButton } from './AdoptProjectButton'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { InlineEdit, PhantomInput } from './ui/inline-editor'

// Issue 015: first-visit backup reminder (ADR-0006), dismissable + remembered.
const BACKUP_NOTE_KEY = 'gede-backup-note-dismissed'

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export function ProjectsList({ onOpen }: { onOpen: (id: string) => void }) {
  const projects = useProjectsStore((s) => s.projects)
  const renameProject = useProjectsStore((s) => s.renameProject)
  const archiveProject = useProjectsStore((s) => s.archiveProject)
  const createProject = useProjectsStore((s) => s.createProject)
  const importProject = useProjectsStore((s) => s.importProject)
  // Issue 070 (fixes #9) — the durable archived-projects view: unlike the
  // generic command-log undo (session-scoped, single most-recent step), this
  // reads the real soft-delete state, so any previously archived project is
  // reachable, not just the last one.
  const archivedProjects = useProjectsStore((s) => s.archivedProjects)
  const loadArchivedProjects = useProjectsStore((s) => s.loadArchivedProjects)
  const restoreArchivedProject = useProjectsStore((s) => s.restoreArchivedProject)
  const undo = useCommandLogStore((s) => s.undo)
  const announce = useStatusStore((s) => s.announce)
  // Issue 069 — defense-in-depth: dedupe by id before rendering, so any
  // upstream duplication (a real duplicated DB row, or a stale/duplicated
  // store array) can never surface as a visibly duplicated row. First
  // occurrence wins; order otherwise matches `projects`.
  const seenIds = new Set<string>()
  const visibleProjects = projects.filter((p) => {
    if (seenIds.has(p.id)) return false
    seenIds.add(p.id)
    return true
  })
  const first = visibleProjects.length === 0

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importedId, setImportedId] = useState<string | null>(null)
  // Issue 065: row click/Enter/Space opens; rename is a deliberate, secondary
  // gesture (the hover/focus-revealed pencil control, or F2). Only one row
  // renames at a time.
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [showBackupNote, setShowBackupNote] = useState(
    () => localStorage.getItem(BACKUP_NOTE_KEY) !== 'dismissed',
  )
  // Issue 070 — a state on `/`, not a new route (consistent with the Design
  // tier's `?view=canvas|coverage` query-param pattern, but this stays local
  // component state rather than growing the route/AppRoute shape for a
  // single-panel toggle nothing else needs to know about).
  const [showArchived, setShowArchived] = useState(false)

  useEffect(() => {
    if (showArchived) void loadArchivedProjects()
  }, [showArchived, loadArchivedProjects])

  // The one import path (button or drop): parse+import through the store, which
  // throws a typed, calm error we render in the panel — never partial, never a
  // dialog. On success the new project is selected and the status line narrates.
  async function importFile(file: File) {
    setImportError(null)
    try {
      const text = await file.text()
      const { project, stats } = await importProject(text)
      setImportedId(project.id)
      const canvases = count(stats.canvases, 'canvas', 'canvases')
      const contexts = count(stats.contexts, 'context', 'contexts')
      announce(`Imported ${project.name} — ${canvases}, ${contexts}`)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Could not import this file')
    }
  }

  function dismissBackupNote() {
    localStorage.setItem(BACKUP_NOTE_KEY, 'dismissed')
    setShowBackupNote(false)
  }

  return (
    <main className="projects">
      <div className="projects__toolbar">
        {!showArchived && (
          <>
            <Button variant="command" onClick={() => fileInputRef.current?.click()}>
              Import project
            </Button>
            <Input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="visually-hidden"
              aria-label="Import project file"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void importFile(file)
                e.target.value = ''
              }}
            />
          </>
        )}
        <Button variant="command" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? 'Back to projects' : 'Archived projects'}
        </Button>
      </div>

      {importError !== null && (
        <p className="import-error" role="alert">
          {importError}
        </p>
      )}

      {/* Issue 070 (fixes #9) — the durable archived-projects view: reuses the
          .project-row layout + rowAction Restore button, per-row, in
          most-recently-archived-first order (listArchivedProjects). Restore
          feedback goes through the shell status bar, same single channel as
          every other narration (SITEMAP §2) — nothing here toasts. */}
      {showArchived ? (
        <section className="panel" aria-label="Archived projects">
          {archivedProjects.length === 0 && <p className="placeholder">No archived projects.</p>}
          {archivedProjects.map((p) => (
            <div key={p.id} className="project-row">
              <span className="project-name">{p.name}</span>
              {p.description !== null && <span className="project-desc">{p.description}</span>}
              <Button
                variant="rowAction"
                aria-label={`Restore ${p.name}`}
                onClick={() => {
                  void restoreArchivedProject(p.id).then(() => {
                    announce(`Restored “${p.name}”`, { label: 'Undo', run: undo })
                  })
                }}
              >
                Restore
              </Button>
            </div>
          ))}
        </section>
      ) : (
      /* Drop a .gede.json anywhere on the panel — the whole surface is a target
          (design brief), highlighted with the accent wash + a dashed hairline. */
      <section
        className="panel projects__droptarget"
        aria-label="Projects"
        data-dragging={dragging || undefined}
        onDragOver={(e) => {
          e.preventDefault()
          if (!dragging) setDragging(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          const file = e.dataTransfer.files[0]
          if (file) void importFile(file)
        }}
      >
        {visibleProjects.map((p) => (
          <div
            key={p.id}
            role="button"
            tabIndex={0}
            aria-label={`Open ${p.name}`}
            className={p.id === importedId ? 'project-row project-row--selected' : 'project-row'}
            onClick={() => onOpen(p.id)}
            onKeyDown={(e) => {
              // F2 is a global rename shortcut — honour it from anywhere in
              // the row (name, Archive button, etc.), same as Windows/Explorer.
              if (e.key === 'F2') {
                e.preventDefault()
                setRenamingId(p.id)
                return
              }
              // Enter/Space open — but only when the row itself is the event
              // target, not when a nested control (Archive, rename) has
              // focus; those already handle their own activation.
              if (e.currentTarget !== e.target) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onOpen(p.id)
              }
            }}
          >
            {/* Row is the primary open target (click/Enter/Space). Rename is a
                deliberate, secondary gesture — the revealed pencil control or
                F2 — so the name itself carries no click handler here; while
                renaming, InlineEdit owns the existing Enter-commit/Esc-revert
                grammar and stops its own clicks/keys from bubbling to the row. */}
            {renamingId === p.id ? (
              <InlineEdit
                value={p.name}
                onCommit={(next) => void renameProject(p.id, next)}
                display={p.name}
                displayClassName="project-name"
                stopPropagation
                editing
                onEditingChange={(next) => setRenamingId(next ? p.id : null)}
              />
            ) : (
              <span className="project-name">{p.name}</span>
            )}
            {p.description !== null && <span className="project-desc">{p.description}</span>}
            {renamingId !== p.id && (
              <Button
                variant="rowAction"
                aria-label={`Rename ${p.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setRenamingId(p.id)
                }}
              >
                <Pencil size={14} aria-hidden="true" />
              </Button>
            )}
            <AdoptProjectButton project={p} />
            <Button
              aria-label={`Archive ${p.name}`}
              onClick={(e) => {
                e.stopPropagation()
                void archiveProject(p.id).then(() => {
                  // Narration goes to the shell status bar — the app's single
                  // feedback channel (SITEMAP §2). "Undo" here undoes the
                  // shared command log's most recent step (issue 006), which
                  // is this archive as long as nothing else happened since.
                  announce(`Archived “${p.name}”`, { label: 'Undo', run: undo })
                })
              }}
            >
              Archive
            </Button>
            <ChevronRight className="project-row__chevron" aria-hidden="true" size={16} />
          </div>
        ))}
        <div className="project-row project-row--phantom">
          <PhantomInput
            placeholder={first ? 'Name your first project' : 'New project'}
            // Returned (not fire-and-forget) so PhantomInput's re-entrancy
            // guard (issue 069) can await it and ignore a second Enter until
            // this create settles.
            onSubmit={(name) => createProject(name)}
          />
        </div>
      </section>
      )}

      {showBackupNote && !showArchived && (
        <footer className="backup-note">
          <span>Projects live in this browser. Export to back up.</span>
          <Button
            variant="bare"
            className="backup-note__dismiss"
            aria-label="Dismiss backup reminder"
            onClick={dismissBackupNote}
          >
            Dismiss
          </Button>
        </footer>
      )}
    </main>
  )
}
