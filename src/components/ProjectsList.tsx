import { useRef, useState } from 'react'
import { useProjectsStore } from '../store/projects'
import { useStatusStore } from '../store/status'

function ProjectName({ id, name }: { id: string; name: string }) {
  const renameProject = useProjectsStore((s) => s.renameProject)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)

  if (!editing) {
    return (
      <span
        className="project-name"
        onClick={(e) => {
          e.stopPropagation()
          setDraft(name)
          setEditing(true)
        }}
      >
        {name}
      </span>
    )
  }
  return (
    <input
      className="inplace-input"
      value={draft}
      autoFocus
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          const next = draft.trim()
          if (next && next !== name) void renameProject(id, next)
          setEditing(false)
        }
        if (e.key === 'Escape') setEditing(false)
      }}
    />
  )
}

function PhantomRow({ first }: { first: boolean }) {
  const createProject = useProjectsStore((s) => s.createProject)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  return (
    <div className="project-row project-row--phantom">
      <input
        ref={inputRef}
        className="inplace-input"
        placeholder={first ? 'Name your first project' : 'New project'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim()) {
            void createProject(draft.trim())
            setDraft('')
            inputRef.current?.focus()
          }
          if (e.key === 'Escape') setDraft('')
        }}
      />
    </div>
  )
}

export function ProjectsList({ onOpen }: { onOpen: (id: string) => void }) {
  const projects = useProjectsStore((s) => s.projects)
  const archiveProject = useProjectsStore((s) => s.archiveProject)
  const undoLast = useProjectsStore((s) => s.undoLast)
  const announce = useStatusStore((s) => s.announce)

  return (
    <main className="projects">
      <section className="panel" aria-label="Projects">
        {projects.map((p) => (
          <div
            key={p.id}
            role="button"
            tabIndex={0}
            aria-label={`Open ${p.name}`}
            className="project-row"
            onClick={() => onOpen(p.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onOpen(p.id)
              if (e.key === 'F2') {
                e.preventDefault()
                ;(e.currentTarget.querySelector('.project-name') as HTMLElement | null)?.click()
              }
            }}
          >
            <ProjectName id={p.id} name={p.name} />
            {p.description !== null && <span className="project-desc">{p.description}</span>}
            <button
              className="row-action"
              aria-label={`Archive ${p.name}`}
              onClick={(e) => {
                e.stopPropagation()
                void archiveProject(p.id).then(() => {
                  // Narration goes to the shell status bar — the app's single
                  // feedback channel (SITEMAP §2).
                  announce(`Archived “${p.name}”`, { label: 'Undo', run: undoLast })
                })
              }}
            >
              Archive
            </button>
          </div>
        ))}
        <PhantomRow first={projects.length === 0} />
      </section>
    </main>
  )
}
