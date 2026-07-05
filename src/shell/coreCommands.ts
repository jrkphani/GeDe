import type { CommandItem } from '../domain/paletteRanking'
import type { CommandProvider } from '../store/commandRegistry'
import { useContextsStore } from '../store/contexts'
import { currentRoute, navigate } from './router'
import type { AppRoute } from './routes'

// Issue 017 — the shell's own command sources. These live in the shell (not the
// palette) so the palette stays feature-agnostic: the shell knows about routes
// and the contexts store; the palette knows only the registry. Feature issues
// (010 compose, 014 export/promote, 015 export/import) register their own verbs
// the same way via useCommandRegistryStore.registerCommand — this is the seam.

function projectIdOf(route: AppRoute): string | null {
  return route.kind === 'tier' || route.kind === 'design' || route.kind === 'project'
    ? route.projectId
    : null
}

// Tier jumps (SITEMAP §1/§4) — only meaningful inside a project, so the source
// yields nothing on the projects list.
const tierSource: CommandProvider = () => {
  const projectId = projectIdOf(currentRoute())
  if (projectId === null) return []
  return [
    {
      id: 'nav.foundation',
      kind: 'tier',
      title: 'Foundation',
      keywords: ['tier 1', 'purpose', 'value'],
      run: () => navigate({ kind: 'tier', projectId, tier: 'foundation' }),
    },
    {
      id: 'nav.architecture',
      kind: 'tier',
      title: 'Architecture',
      keywords: ['tier 2', 'tables'],
      run: () => navigate({ kind: 'tier', projectId, tier: 'architecture' }),
    },
    {
      id: 'nav.design',
      kind: 'tier',
      title: 'Design',
      keywords: ['tier 3', 'canvas', 'register'],
      run: () => navigate({ kind: 'design', projectId, contextPath: [], view: 'canvas' }),
    },
  ]
}

// Canvases (SITEMAP §3) — the root canvas today; child canvases arrive with the
// recursion slice (011), which can extend this same source.
const canvasSource: CommandProvider = () => {
  const projectId = projectIdOf(currentRoute())
  if (projectId === null) return []
  return [
    {
      id: 'canvas.root',
      kind: 'canvas',
      title: 'Root canvas',
      keywords: ['root', 'canvas', 'design'],
      run: () => navigate({ kind: 'design', projectId, contextPath: [], view: 'canvas' }),
    },
    {
      id: 'view.coverage',
      kind: 'canvas',
      title: 'Coverage matrix',
      keywords: ['coverage', 'matrix', 'gaps'],
      run: () => navigate({ kind: 'design', projectId, contextPath: [], view: 'coverage' }),
    },
  ]
}

// Contexts (SITEMAP §3) — matched by symbol/name/justification. Selecting one
// navigates to its canvas AND selects it, reusing the shared selection field
// (issue 009). Reads the live store, so it only lists contexts once the design
// surface has loaded them this session.
const contextSource: CommandProvider = () => {
  const projectId = projectIdOf(currentRoute())
  if (projectId === null) return []
  const { contexts } = useContextsStore.getState()
  return contexts.map(
    (c): CommandItem => ({
      id: `context.${c.id}`,
      kind: 'context',
      title: c.name?.trim() ? c.name.trim() : c.symbol,
      symbol: c.symbol,
      keywords: [c.symbol, c.justification ?? ''],
      run: () => {
        navigate({ kind: 'design', projectId, contextPath: [], view: 'canvas' })
        useContextsStore.getState().select(c.id)
      },
    }),
  )
}

export function coreCommandSources(): CommandProvider[] {
  return [tierSource, canvasSource, contextSource]
}
