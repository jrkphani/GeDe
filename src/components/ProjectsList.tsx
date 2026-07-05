import { useCommandLogStore } from '../store/commandLog'
import { useProjectsStore } from '../store/projects'
import { useStatusStore } from '../store/status'
import { Button } from './ui/button'
import { InlineEdit, PhantomInput } from './ui/inline-editor'

export function ProjectsList({ onOpen }: { onOpen: (id: string) => void }) {
  const projects = useProjectsStore((s) => s.projects)
  const renameProject = useProjectsStore((s) => s.renameProject)
  const archiveProject = useProjectsStore((s) => s.archiveProject)
  const createProject = useProjectsStore((s) => s.createProject)
  const undo = useCommandLogStore((s) => s.undo)
  const announce = useStatusStore((s) => s.announce)
  const first = projects.length === 0

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
    </main>
  )
}
