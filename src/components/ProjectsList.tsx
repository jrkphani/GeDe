import { useRef, useState } from 'react'
import { useCommandLogStore } from '../store/commandLog'
import { useProjectsStore } from '../store/projects'
import { useStatusStore } from '../store/status'
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
  const undo = useCommandLogStore((s) => s.undo)
  const announce = useStatusStore((s) => s.announce)
  const first = projects.length === 0

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importedId, setImportedId] = useState<string | null>(null)
  const [showBackupNote, setShowBackupNote] = useState(
    () => localStorage.getItem(BACKUP_NOTE_KEY) !== 'dismissed',
  )

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
        <Button onClick={() => fileInputRef.current?.click()}>Import project</Button>
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
      </div>

      {importError !== null && (
        <p className="import-error" role="alert">
          {importError}
        </p>
      )}

      {/* Drop a .gede.json anywhere on the panel — the whole surface is a target
          (design brief), highlighted with the accent wash + a dashed hairline. */}
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
        {projects.map((p) => (
          <div
            key={p.id}
            role="button"
            tabIndex={0}
            aria-label={`Open ${p.name}`}
            className={p.id === importedId ? 'project-row project-row--selected' : 'project-row'}
            onClick={() => onOpen(p.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onOpen(p.id)
              if (e.key === 'F2') {
                e.preventDefault()
                e.currentTarget.querySelector<HTMLElement>('.project-name')?.click()
              }
            }}
          >
            {/* Row is clickable-to-open, so the editor stops click/key propagation. */}
            <InlineEdit
              value={p.name}
              onCommit={(next) => void renameProject(p.id, next)}
              display={p.name}
              displayClassName="project-name"
              stopPropagation
            />
            {p.description !== null && <span className="project-desc">{p.description}</span>}
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
          </div>
        ))}
        <div className="project-row project-row--phantom">
          <PhantomInput
            placeholder={first ? 'Name your first project' : 'New project'}
            onSubmit={(name) => void createProject(name)}
          />
        </div>
      </section>

      {showBackupNote && (
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
