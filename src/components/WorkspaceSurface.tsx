import { ArchitectureSurface } from './ArchitectureSurface'
import { DesignSurface } from './DesignSurface'
import { FoundationSurface } from './FoundationSurface'
import type { AppRoute } from '../shell/routes'

// Issue 089 D2 Phase 1 — the unified workspace. The three tier surfaces that
// used to each own the whole scroll region (one per route) now render as
// side-by-side vertical lanes on a single page, inside the existing `.surface`
// scroll container. The ROUTE GRAMMAR is unchanged (SITEMAP §1): the URL still
// parses/serializes exactly as before and still carries Design's
// contextPath / view / canvasId — this component only changes WHAT the route
// mounts (all three lanes at once instead of the single-surface switch in
// App.tsx). Scroll-to-lane deep-linking (P2), active-lane handler scoping (P3),
// and per-lane sticky context headers (P4) are later phases.
//
// All three surfaces' load effects are idempotent and projectId-keyed
// (FoundationSurface tier1, ArchitectureSurface tier2, DesignSurface canvases /
// dimensions / contexts / parameters + healRichTextOnLoad), so co-mounting them
// needs no load orchestration. DesignSurface renders null until its canvas
// store resolves (canvasReady), so its lane is briefly empty on first paint —
// acceptable for P1.

type WorkspaceRoute = Extract<AppRoute, { kind: 'project' | 'tier' | 'design' }>

export function WorkspaceSurface({ route }: { route: WorkspaceRoute }) {
  const projectId = route.projectId
  // The Design lane derives contextPath / view / canvasId from the route only
  // when the route is a design route; on a foundation/architecture/project
  // route the Design lane still mounts, showing the project's root canvas at
  // depth 0 in the default canvas view.
  const design =
    route.kind === 'design'
      ? { contextPath: route.contextPath, view: route.view, canvasId: route.canvasId }
      : { contextPath: [] as string[], view: 'canvas' as const, canvasId: undefined }

  return (
    <div className="workspace">
      <section className="workspace__lane workspace__lane--foundation">
        <FoundationSurface projectId={projectId} />
      </section>
      <section className="workspace__lane workspace__lane--architecture">
        <ArchitectureSurface projectId={projectId} />
      </section>
      <section className="workspace__lane workspace__lane--design">
        <DesignSurface
          key={projectId}
          projectId={projectId}
          contextPath={design.contextPath}
          view={design.view}
          canvasId={design.canvasId}
        />
      </section>
    </div>
  )
}
