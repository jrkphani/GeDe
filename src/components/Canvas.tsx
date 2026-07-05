import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { CENTER, layout, NODE_RADIUS } from '../domain/canvasLayout'
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
    () => layout({ dimensions, parametersByDimension, contexts, bindingsByContext }),
    [dimensions, parametersByDimension, contexts, bindingsByContext],
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
  const selectedNode = selectedContextId
    ? geometry.nodes.find((n) => n.contextId === selectedContextId)
    : undefined

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
        {geometry.arcs.map((arc) => (
          <g
            key={arc.dimensionId}
            className="canvas-arc-group"
            data-dimension-id={arc.dimensionId}
            // In compose mode only the active dimension reads at full strength
            // (guided binding, SPEC §4.2); in read mode every arc is "active".
            data-active={activeDimensionId === null ? 'true' : String(arc.dimensionId === activeDimensionId)}
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
                textAnchor="middle"
              >
                {arc.label}
              </text>
            ) : null}
          </g>
        ))}

        {geometry.dots.map((dot) => {
          const isBound = composing && draftBindings[dot.dimensionId] === dot.parameterId
          return (
            <g
              key={`${dot.dimensionId}:${dot.parameterId}`}
              className={cn('canvas-dot-group', {
                'canvas-dot-group--compose': composing,
                'canvas-dot-group--bound': isBound,
              })}
              data-dimension-id={dot.dimensionId}
              data-parameter-id={dot.parameterId}
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
              {composing ? <circle className="canvas-dot-hit" cx={dot.x} cy={dot.y} r={hitRadius} /> : null}
              <circle
                className="canvas-dot"
                data-dimension-id={dot.dimensionId}
                data-parameter-id={dot.parameterId}
                cx={dot.x}
                cy={dot.y}
                r={5}
                style={{ fill: dot.color }}
              />
            </g>
          )
        })}

        {selectedContextId && selectedNode
          ? Object.entries(bindingsByContext[selectedContextId] ?? {}).map(([dimensionId, parameterId]) => {
              const dimension = dimensions.find((d) => d.id === dimensionId)
              const to = dotPositionByKey.get(`${dimensionId}:${parameterId}`)
              if (!dimension || !to) return null
              return (
                <line
                  key={dimensionId}
                  className="canvas-spoke"
                  data-dimension-id={dimensionId}
                  x1={selectedNode.x}
                  y1={selectedNode.y}
                  x2={to.x}
                  y2={to.y}
                  style={{ stroke: dimension.color }}
                />
              )
            })
          : null}

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

          return (
            <g
              key={node.contextId}
              ref={(el) => {
                nodeRefs.current[node.contextId] = el
              }}
              className={cn('canvas-node', {
                'canvas-node--draft': node.isDraft,
                'canvas-node--dimmed': dimmed,
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
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                  e.preventDefault()
                  moveSelection(index, 1)
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                  e.preventDefault()
                  moveSelection(index, -1)
                } else if (e.key === 'Escape') {
                  // Esc order (SITEMAP §4): in compose mode it exits compose,
                  // keeping the draft; otherwise it clears the selection.
                  if (composeContextId) onExitCompose?.()
                  else onSelect(null)
                }
                // Enter: drill-down arrives in issue 011 — no-op for now.
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
          <text className="canvas-empty-prompt" x={500} y={500} textAnchor="middle">
            Bind your first context
          </text>
        ) : null}
      </svg>
    </div>
  )
}
