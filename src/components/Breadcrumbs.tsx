import { navigate } from '../shell/router'
import { serializeRoute } from '../shell/routes'

// SITEMAP §1/§2/§3 — the depth trail: `Root ▸ α ▸ α2`. URL segments are context
// ids (stable under rename); crumbs display mono symbols. Every crumb but the
// current is a link that navigates to that depth (browser back/forward mirror
// it exactly, since each is a real history entry via navigate()). The current
// canvas's dimension names trail the crumbs as muted context (design brief).
//
// Overflow (SITEMAP §3): with a deep trail the middle crumbs collapse to a
// single `…` (its title lists them); root and current stay visible.

export interface Crumb {
  id: string
  symbol: string
}

function DesignCrumb({
  projectId,
  label,
  contextPath,
  current,
}: {
  projectId: string
  label: string
  contextPath: string[]
  current: boolean
}) {
  if (current) {
    return (
      <span className="breadcrumb breadcrumb--current" aria-current="page">
        {label}
      </span>
    )
  }
  const route = { kind: 'design', projectId, contextPath, view: 'canvas' } as const
  return (
    <a
      className="breadcrumb breadcrumb--link"
      href={serializeRoute(route)}
      onClick={(e) => {
        e.preventDefault()
        navigate(route)
      }}
    >
      {label}
    </a>
  )
}

export function Breadcrumbs({
  projectId,
  crumbs,
  dimensionNames,
}: {
  projectId: string
  crumbs: readonly Crumb[]
  dimensionNames?: readonly string[]
}) {
  const ids = crumbs.map((c) => c.id)
  // Root ▸ [middle…] ▸ parent ▸ current. Collapse the middle when the trail is
  // deep (keep root + last two visible).
  const COLLAPSE_AFTER = 4
  const collapse = crumbs.length + 1 > COLLAPSE_AFTER
  const hiddenCount = collapse ? crumbs.length - 2 : 0
  const hidden = collapse ? crumbs.slice(0, hiddenCount) : []
  const shown = collapse ? crumbs.slice(hiddenCount) : crumbs
  const shownOffset = collapse ? hiddenCount : 0

  return (
    <nav className="breadcrumbs" aria-label="Canvas depth">
      <DesignCrumb
        projectId={projectId}
        label="Root"
        contextPath={[]}
        current={crumbs.length === 0}
      />
      {collapse ? (
        <>
          <span className="breadcrumb__sep" aria-hidden="true">
            ▸
          </span>
          <span
            className="breadcrumb breadcrumb--ellipsis"
            title={hidden.map((c) => c.symbol).join(' ▸ ')}
          >
            …
          </span>
        </>
      ) : null}
      {shown.map((crumb, i) => {
        const depth = shownOffset + i
        return (
          <span key={crumb.id} className="breadcrumb__group">
            <span className="breadcrumb__sep" aria-hidden="true">
              ▸
            </span>
            <DesignCrumb
              projectId={projectId}
              label={crumb.symbol}
              contextPath={ids.slice(0, depth + 1)}
              current={depth === crumbs.length - 1}
            />
          </span>
        )
      })}
      {dimensionNames && dimensionNames.length > 0 ? (
        <span className="breadcrumbs__dims" title={`Refining ${dimensionNames.join(', ')}`}>
          {dimensionNames.join(' · ')}
        </span>
      ) : null}
    </nav>
  )
}
