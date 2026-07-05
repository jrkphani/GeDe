import { useEffect } from 'react'
import { ProjectsList } from './components/ProjectsList'
import { useProjectsStore } from './store/projects'

function ProjectShell({ id }: { id: string }) {
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === id))
  const closeProject = useProjectsStore((s) => s.closeProject)
  // Tier tabs and routes arrive with issue 016; this is the minimal open state.
  return (
    <main className="projects">
      <section className="panel" aria-label={project?.name}>
        <h2 className="project-title">{project?.name}</h2>
        <button className="row-action" onClick={closeProject}>
          Back to projects
        </button>
      </section>
    </main>
  )
}

export default function App() {
  const status = useProjectsStore((s) => s.status)
  const error = useProjectsStore((s) => s.error)
  const openProjectId = useProjectsStore((s) => s.openProjectId)

  useEffect(() => {
    void useProjectsStore.getState().init()
  }, [])

  return (
    <div data-db-ready={status === 'ready'}>
      <h1 className="wordmark">GeDe</h1>
      {status === 'error' && (
        <main className="projects">
          <section className="panel" role="alert">
            <p>Storage is unavailable: {error}</p>
            <p>Export/import will still work from memory this session.</p>
          </section>
        </main>
      )}
      {status === 'ready' &&
        (openProjectId !== null ? <ProjectShell id={openProjectId} /> : <ProjectsList />)}
    </div>
  )
}
