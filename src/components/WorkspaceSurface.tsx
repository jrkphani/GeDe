import { ArchitectureSurface } from './ArchitectureSurface'
import { DesignSurface } from './DesignSurface'
import { FoundationSurface } from './FoundationSurface'
import { useActiveLaneStore } from '../store/activeLane'
import type { AppRoute } from '../shell/routes'

// Issue 089 D2 Phase 1 — the unified workspace. The three tier surfaces that
// used to each own the whole scroll region (one per route) now render as
// side-by-side vertical lanes on a single page, inside the existing `.surface`
// scroll container. The ROUTE GRAMMAR is unchanged (SITEMAP §1): the URL still
// parses/serializes exactly as before and still carries Design's
// contextPath / view / canvasId — this component only changes WHAT the route
// mounts (all three lanes at once instead of the single-surface switch in
// App.tsx). Scroll-to-lane deep-linking (P2) and active-lane handler scoping
// (P3) are earlier phases.
//
// 089 D2 P4 — per-lane sticky context headers: each surface now renders its own
// context content as an in-lane `.workspace__lane-header` (position: sticky) at
// the top of its lane column, instead of portaling into the single shared shell
// `.context-bar` slot (which co-mounting made jumble Architecture's quick-jump
// with Design's breadcrumbs/switcher/coverage). The shell slot is left to host
// ONLY the focus-revealed D1 FormatStrip. Each lane's own content scrolls under
// its sticky header within the shared `.surface` scroll region; below ~1024px
// the `.workspace` row reflows to a stacked single column (base.css), where
// ⌘1/2/3 scroll-to-lane is the load-bearing navigation.
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

  // 089 D2 P3 — the active-lane setter (a stable Zustand action, so selecting
  // it never re-renders this component on lane changes). Each lane records
  // itself as active on BOTH focusin and pointerdown:
  //   • focusin — the keyboard path: Tab/click into any focusable control in a
  //     lane makes that lane active. React's onFocusCapture maps to the
  //     bubbling focusin (capture phase), so it fires for focus landing on any
  //     descendant.
  //   • pointerdown — the mouse path, and the ROBUSTNESS the Design lane needs:
  //     its Canvas is a non-focusable <svg>, so clicking a node fires no focus
  //     event at all. pointerdown on the lane still sets it active even when
  //     the click target can't take focus.
  // Both set the SAME lane for a given section, so their firing order on a
  // focusable click (pointerdown → focus) is immaterial — idempotent, never a
  // fight. Design's `c` / `v` / `d` verbs read this slice non-reactively.
  const setActiveLane = useActiveLaneStore((s) => s.setActiveLane)

  return (
    <div className="workspace">
      <section
        className="workspace__lane workspace__lane--foundation"
        onFocusCapture={() => setActiveLane('foundation')}
        onPointerDown={() => setActiveLane('foundation')}
      >
        <FoundationSurface projectId={projectId} />
      </section>
      <section
        className="workspace__lane workspace__lane--architecture"
        onFocusCapture={() => setActiveLane('architecture')}
        onPointerDown={() => setActiveLane('architecture')}
      >
        <ArchitectureSurface projectId={projectId} />
      </section>
      <section
        className="workspace__lane workspace__lane--design"
        onFocusCapture={() => setActiveLane('design')}
        onPointerDown={() => setActiveLane('design')}
      >
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
