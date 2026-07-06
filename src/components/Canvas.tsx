import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { adjacentSet, dotKey, type CanvasEmphasis } from '../domain/canvasAdjacency'
import { CENTER, DOT_RADIUS, layout, NODE_RADIUS, spokePath } from '../domain/canvasLayout'
import { dotHitRadiusUnits, labelTierForWidth, type CanvasLabelTier } from '../domain/canvasResponsive'
import { documentedStatus, isComplete } from '../domain/completeness'
import { describeContext, tupleReadout } from '../domain/contextDescription'
import type { ContextRow, DimensionRow, ParameterRow } from '../db/mutations'

// Issue 008/009 — circle canvas (SPEC §4.2, ADR-0001/0005). Data shapes
// mirror what ContextRegister already reads off the stores, so DesignSurface
// can feed both projections from one set of subscriptions (SPEC invariant 6).
// Selection is fully controlled: this component owns no selection state of
// its own (neither projection owns it — issue 009 acceptance criterion).
export interface CanvasProps {
  dimensions: readonly DimensionRow[]
  parametersByDimension: Readonly<Record<string, readonly ParameterRow[]>>
  contexts: readonly ContextRow[]
  bindingsByContext: Readonly<Record<string, Readonly<Record<string, string>>>>
  selectedContextId: string | null
  onSelect: (id: string | null) => void
  // Issue 010 — compose mode. When `composeContextId` is set, that context is
  // the live draft: parameter dots become interactive (click to bind/unbind),
  // the active dimension's arc reads at full strength while the rest recede,
  // and Escape exits compose (keeping the draft) rather than clearing
  // selection. All null/undefined in read mode — the canvas stays presentational
  // and mutation-free, exactly like selection (DesignSurface owns the store).
  composeContextId?: string | null
  activeDimensionId?: string | null
  onBindParameter?: (dimensionId: string, parameterId: string) => void
  onUnbindParameter?: (dimensionId: string) => void
  onExitCompose?: () => void
  // Issue 011 — drilling into a context (double-click / Enter) opens its child
  // canvas. Presentational: DesignSurface owns the navigation. Child counts
  // feed the node badge (a canvas holds only one level of contexts, so the
  // count comes from the store, not the loaded set).
  onDrillIn?: (contextId: string) => void
  childCountByContext?: Readonly<Record<string, number>> | undefined
  // Issue 011 — on a child canvas, the dimension names ARE the parent tuple
  // being refined; shown as a lineage line under the empty-state prompt so
  // "where am I / what is this refining" is always answerable.
  lineage?: readonly string[] | undefined
  // Issue 028(a) — focus + adjacency (STYLE_GUIDE §7/§8, amended). The
  // transient hover/keyboard-focus mark, owned by DesignSurface exactly like
  // selectedContextId; Canvas raises changes via onHoverChange and falls
  // back to treating the current selection as a 'context' emphasis when
  // nothing is hovered/focused ("hover ?? selection" — see the design brief).
  // Both default to inert (no emphasis, no callback) so every pre-028 caller
  // and test keeps its exact prior rendering.
  hoveredMark?: CanvasEmphasis | null
  onHoverChange?: (mark: CanvasEmphasis | null) => void
}

function useElementWidth(): [React.RefObject<HTMLDivElement | null>, number | null] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState<number | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return [ref, width]
}

const LABEL_TIER_FALLBACK: CanvasLabelTier = 'full'

const HIT_REFERENCE_WIDTH = 500

// Issue 023 — STYLE_GUIDE §7 responsive degradation is "shrink one step ->
// truncate -> legend, no jiggle". Dimension arc labels are short by
// construction (a handful of named axes); parameter labels are user-authored
// and can be long, so the 400-640px "truncated" tier needs an actual
// truncation step (dimension labels don't have one yet — out of scope here).
// A full anti-collision/measure-text solver is explicitly out of scope per
// the issue; this is a deterministic char-count truncation.
const PARAM_LABEL_TRUNCATE_LENGTH = 8

function truncateParamLabel(label: string): string {
  if (label.length <= PARAM_LABEL_TRUNCATE_LENGTH) return label
  return `${label.slice(0, PARAM_LABEL_TRUNCATE_LENGTH - 1)}…`
}

export function Canvas({
  dimensions,
  parametersByDimension,
  contexts,
  bindingsByContext,
  selectedContextId,
  onSelect,
  composeContextId = null,
  activeDimensionId = null,
  onBindParameter,
  onUnbindParameter,
  onExitCompose,
  onDrillIn,
  childCountByContext,
  lineage,
  hoveredMark = null,
  onHoverChange,
}: CanvasProps) {
  const [shellRef, width] = useElementWidth()
  const labelTier = width === null ? LABEL_TIER_FALLBACK : labelTierForWidth(width)
  const nodeRefs = useRef<Record<string, SVGGElement | null>>({})

  const composing = composeContextId !== null
  const draftBindings = composeContextId ? (bindingsByContext[composeContextId] ?? {}) : {}
  // Invisible ≥44px hit circle in viewBox units (STYLE_GUIDE §7), derived from
  // the *measured* on-screen width so the target stays 44px at any scale.
  const hitRadius = dotHitRadiusUnits(width && width > 0 ? width : HIT_REFERENCE_WIDTH)

  const geometry = useMemo(
    () => layout({ dimensions, parametersByDimension, contexts, bindingsByContext, childCountByContext }),
    [dimensions, parametersByDimension, contexts, bindingsByContext, childCountByContext],
  )

  const dimensionIds = useMemo(() => dimensions.map((d) => d.id), [dimensions])

  const paramNameById = useMemo(() => {
    const map: Record<string, string> = {}
    for (const list of Object.values(parametersByDimension)) {
      for (const p of list) map[p.id] = p.name
    }
    return map
  }, [parametersByDimension])

  const contextById = useMemo(() => new Map(contexts.map((c) => [c.id, c])), [contexts])

  // Issue 009 — bound-dot lookup backing the selected context's spokes;
  // spokes only draw where a dot actually exists (an unbound dimension has
  // none), a necessary reading of the design brief's literal "n spokes" for
  // a draft context.
  const dotPositionByKey = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>()
    for (const dot of geometry.dots) map.set(`${dot.dimensionId}:${dot.parameterId}`, { x: dot.x, y: dot.y })
    return map
  }, [geometry.dots])

  const isEmpty = contexts.length === 0

  // Issue 028(a) — the emphasis actually driving muting/spokes this render:
  // an active hover/keyboard-focus wins; absent that, a locked selection acts
  // as its own 'context' emphasis (STYLE_GUIDE §7 "hover ?? selection"), so
  // spokes/adjacency reduce to exactly the pre-028 selection-only behaviour
  // when nothing is hovered. Suppressed entirely while composing — compose
  // mode already has its own active-dimension emphasis grammar (010) and this
  // feature is explicitly out of scope for it (issue 028 Scope).
  const resolvedEmphasis: CanvasEmphasis | null =
    hoveredMark ?? (selectedContextId ? { id: selectedContextId, role: 'context' } : null)
  const adjacent = useMemo(
    () => adjacentSet(resolvedEmphasis, { bindingsByContext, dots: geometry.dots }),
    [resolvedEmphasis, bindingsByContext, geometry.dots],
  )
  const hasEmphasis = !composing && resolvedEmphasis !== null

  function moveSelection(fromIndex: number, delta: 1 | -1) {
    const n = geometry.nodes.length
    if (n === 0) return
    const nextIndex = (fromIndex + delta + n) % n
    const next = geometry.nodes[nextIndex]
    if (!next) return
    onSelect(next.contextId)
    nodeRefs.current[next.contextId]?.focus()
  }

  return (
    <div className="canvas-shell" data-label-tier={labelTier} ref={shellRef}>
      <svg
        className="canvas-svg"
        viewBox={geometry.viewBox}
        role="img"
        aria-label="Context canvas"
        data-empty={isEmpty}
        onClick={(e) => {
          // Click-away-to-deselect: only when the click lands on the SVG
          // background itself, not bubbled up from a node (a node click
          // already calls onSelect with its own id — this would otherwise
          // immediately clear it again). The main path back to a clean
          // deselected state once focus has left the canvas entirely (e.g.
          // after editing the composer's justification field) — Escape
          // alone only reaches a canvas node's own handler when that node
          // still has focus.
          if (e.target === e.currentTarget) onSelect(null)
        }}
      >
        {geometry.arcs.map((arc) => {
          const muted = hasEmphasis && !adjacent.dimensionIds.has(arc.dimensionId)
          return (
          <g
            key={arc.dimensionId}
            className={cn('canvas-arc-group', { 'canvas--muted': muted })}
            data-dimension-id={arc.dimensionId}
            // In compose mode only the active dimension reads at full strength
            // (guided binding, SPEC §4.2); in read mode every arc is "active".
            data-active={activeDimensionId === null ? 'true' : String(arc.dimensionId === activeDimensionId)}
            // Issue 028(a) — hover/focus emphasis (STYLE_GUIDE §7, amended).
            // Suppressed while composing (own emphasis grammar, out of scope).
            onMouseEnter={composing ? undefined : () => onHoverChange?.({ id: arc.dimensionId, role: 'dimension' })}
            onMouseLeave={composing ? undefined : () => onHoverChange?.(null)}
          >
            <path
              className="canvas-arc"
              data-dimension-id={arc.dimensionId}
              data-empty={arc.empty}
              d={arc.d}
              transform={`translate(${CENTER},${CENTER})`}
              style={{ fill: arc.color }}
            />
            {labelTier !== 'legend' ? (
              <text
                className="canvas-arc-label"
                x={arc.labelPos.x}
                y={arc.labelPos.y}
                textAnchor={arc.labelAnchor}
                dominantBaseline="central"
              >
                {arc.label}
              </text>
            ) : null}
          </g>
          )
        })}

        {geometry.dots.map((dot) => {
          const isBound = composing && draftBindings[dot.dimensionId] === dot.parameterId
          // A hovered/focused parameter's own dot never mutes itself away —
          // adjacentSet deliberately doesn't return a parameter's own dot key
          // (see canvasAdjacency.ts), so Canvas checks the reflexive case here.
          const isEmphasisSelf = resolvedEmphasis?.role === 'parameter' && resolvedEmphasis.id === dot.parameterId
          const muted = hasEmphasis && !isEmphasisSelf && !adjacent.dotKeys.has(dotKey(dot.dimensionId, dot.parameterId))
          return (
            <g
              key={`${dot.dimensionId}:${dot.parameterId}`}
              className={cn('canvas-dot-group', {
                'canvas-dot-group--compose': composing,
                'canvas-dot-group--bound': isBound,
                'canvas--muted': muted,
              })}
              data-dimension-id={dot.dimensionId}
              data-parameter-id={dot.parameterId}
              // Issue 028(a) — read-mode dots gain hover + keyboard focus so
              // "which contexts use this parameter" is answerable without a
              // click (STYLE_GUIDE §7). Suppressed while composing: the dot's
              // own click handler already owns that interaction there.
              tabIndex={composing ? undefined : 0}
              onMouseEnter={composing ? undefined : () => onHoverChange?.({ id: dot.parameterId, role: 'parameter' })}
              onMouseLeave={composing ? undefined : () => onHoverChange?.(null)}
              onFocus={composing ? undefined : () => onHoverChange?.({ id: dot.parameterId, role: 'parameter' })}
              onBlur={composing ? undefined : () => onHoverChange?.(null)}
              onClick={
                composing
                  ? () => {
                      // Toggle: clicking the bound dot unbinds, any other dot
                      // (re)binds its dimension. Read mode has no handler at
                      // all, so a dot click can never mutate (SPEC invariant 2
                      // — mode gates mutation; read-mode clicks only select).
                      if (draftBindings[dot.dimensionId] === dot.parameterId) onUnbindParameter?.(dot.dimensionId)
                      else onBindParameter?.(dot.dimensionId, dot.parameterId)
                    }
                  : undefined
              }
            >
              {/* Issue 028(a) — the invisible ≥44px hit circle (STYLE_GUIDE
                  §7) now renders in read mode too, not only while composing:
                  hover/focus emphasis needs a real target, and the painted
                  8px `.canvas-dot` circle alone is too small to reliably
                  hover/focus in a real browser. It carries no click handler
                  outside compose mode, so SPEC invariant 2 (mode gates
                  mutation) is untouched. */}
              <circle className="canvas-dot-hit" cx={dot.x} cy={dot.y} r={hitRadius} />
              <circle
                className="canvas-dot"
                data-dimension-id={dot.dimensionId}
                data-parameter-id={dot.parameterId}
                cx={dot.x}
                cy={dot.y}
                r={DOT_RADIUS}
                style={{ fill: dot.color }}
              />
              {labelTier !== 'legend' ? (
                <text
                  className="canvas-param-label"
                  x={dot.labelPos.x}
                  y={dot.labelPos.y}
                  textAnchor={dot.labelAnchor}
                  dominantBaseline="central"
                >
                  {labelTier === 'truncated' ? truncateParamLabel(dot.label) : dot.label}
                </text>
              ) : null}
            </g>
          )
        })}

        {/* Issue 009's selection-only spokes generalize to issue 028(a)'s
            adjacency: draw every bound-dimension spoke for every context in
            `adjacent.contextIds`. With no hover, that set is exactly
            `{selectedContextId}` (via the emphasis fallback above), so this
            reproduces the pre-028 rendering unchanged; a parameter/dimension
            hover additionally lights up whichever OTHER contexts are
            adjacent — "who uses this parameter/dimension" (issue 028 Scope).
            Issue 039 (028 phase b): the spoke is a `<path>` built by the pure
            `spokePath(from, to)` (deterministic bundled curve toward CENTER)
            instead of a straight `<line>` — geometry lives in the layout,
            Canvas just renders the `d` it's handed. Class/data-attributes are
            unchanged so 028(a)'s muting and every existing `.canvas-spoke`
            count/point assertion keep passing. */}
        {Array.from(adjacent.contextIds).flatMap((ctxId) => {
          const fromNode = geometry.nodes.find((n) => n.contextId === ctxId)
          if (!fromNode) return []
          return Object.entries(bindingsByContext[ctxId] ?? {}).flatMap(([dimensionId, parameterId]) => {
            const dimension = dimensions.find((d) => d.id === dimensionId)
            const to = dotPositionByKey.get(dotKey(dimensionId, parameterId))
            if (!dimension || !to) return []
            return [
              <path
                key={`${ctxId}:${dimensionId}`}
                className="canvas-spoke"
                data-dimension-id={dimensionId}
                d={spokePath(fromNode, to)}
                style={{ stroke: dimension.color }}
              />,
            ]
          })
        })}

        {geometry.nodes.map((node, index) => {
          const ctxRow = contextById.get(node.contextId)
          const bindings = bindingsByContext[node.contextId] ?? {}
          const bound = new Set(Object.keys(bindings))
          const status = documentedStatus(isComplete(dimensionIds, bound), ctxRow?.justification)
          const tuple = tupleReadout(dimensions, bindings, paramNameById)
          const label = describeContext(node.symbol, tuple, status)
          const isSelected = selectedContextId === node.contextId
          const isTabStop = selectedContextId ? isSelected : index === 0
          const dimmed = selectedContextId !== null && !isSelected
          const muted = hasEmphasis && !adjacent.contextIds.has(node.contextId)

          return (
            <g
              key={node.contextId}
              ref={(el) => {
                nodeRefs.current[node.contextId] = el
              }}
              className={cn('canvas-node', {
                'canvas-node--draft': node.isDraft,
                'canvas-node--dimmed': dimmed,
                'canvas--muted': muted,
              })}
              // The node's position lives on the group transform (not per-shape
              // x/y) so it can ease toward its recomputed centroid after each
              // bind (single ~120ms migration, STYLE_GUIDE §8) via a CSS
              // transform transition — which `prefers-reduced-motion` disables
              // for free, snapping straight to the correct final position.
              transform={`translate(${node.x},${node.y})`}
              data-context-id={node.contextId}
              role="button"
              tabIndex={isTabStop ? 0 : -1}
              aria-label={label}
              aria-pressed={isSelected}
              onClick={() => onSelect(node.contextId)}
              // Issue 028(a) — hover/focus emphasis. Suppressed while
              // composing (own emphasis grammar, out of scope).
              onMouseEnter={composing ? undefined : () => onHoverChange?.({ id: node.contextId, role: 'context' })}
              onMouseLeave={composing ? undefined : () => onHoverChange?.(null)}
              onFocus={composing ? undefined : () => onHoverChange?.({ id: node.contextId, role: 'context' })}
              onBlur={composing ? undefined : () => onHoverChange?.(null)}
              // Double-click drills into the context's child canvas (SPEC
              // §4.2, issue 011). Never in compose mode (the draft isn't a
              // stable canvas yet).
              onDoubleClick={() => {
                if (!composeContextId) onDrillIn?.(node.contextId)
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                  e.preventDefault()
                  moveSelection(index, 1)
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  moveSelection(index, -1)
                } else if (e.key === 'Enter') {
                  // Enter drills into the node's child canvas (SPEC §4.2).
                  if (!composeContextId) {
                    e.preventDefault()
                    onDrillIn?.(node.contextId)
                  }
                } else if (e.key === 'Escape') {
                  // Esc order (SITEMAP §4): in compose mode it exits compose,
                  // keeping the draft; otherwise it clears the selection.
                  if (composeContextId) onExitCompose?.()
                  else onSelect(null)
                }
              }}
            >
              <circle cx={0} cy={0} r={NODE_RADIUS} />
              <text x={0} y={0} textAnchor="middle" dominantBaseline="central">
                {node.symbol}
              </text>
              {node.childCount > 0 ? (
                <text className="canvas-node-badge" x={NODE_RADIUS} y={-NODE_RADIUS}>
                  {node.childCount}
                </text>
              ) : null}
            </g>
          )
        })}

        {isEmpty ? (
          <>
            <text className="canvas-empty-prompt" x={500} y={500} textAnchor="middle">
              Bind your first context
            </text>
            {lineage && lineage.length > 0 ? (
              <text className="canvas-empty-lineage" x={500} y={540} textAnchor="middle">
                Refining {lineage.join(', ')}
              </text>
            ) : null}
          </>
        ) : null}
      </svg>
    </div>
  )
}
