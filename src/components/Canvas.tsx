import { useEffect, useMemo, useRef, useState } from 'react'
import { CENTER, layout, NODE_RADIUS } from '../domain/canvasLayout'
import { labelTierForWidth, type CanvasLabelTier } from '../domain/canvasResponsive'
import type { ContextRow, DimensionRow, ParameterRow } from '../db/mutations'

// Issue 008 — read-only circle canvas (SPEC §4.2, ADR-0001/0005). No
// selection, no editing, no hover state: those arrive in 009/010. Data shapes
// mirror what ContextRegister already reads off the stores, so DesignSurface
// can feed both projections from one set of subscriptions (SPEC invariant 6).
export interface CanvasProps {
  dimensions: readonly DimensionRow[]
  parametersByDimension: Readonly<Record<string, readonly ParameterRow[]>>
  contexts: readonly ContextRow[]
  bindingsByContext: Readonly<Record<string, Readonly<Record<string, string>>>>
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

export function Canvas({ dimensions, parametersByDimension, contexts, bindingsByContext }: CanvasProps) {
  const [shellRef, width] = useElementWidth()
  const labelTier = width === null ? LABEL_TIER_FALLBACK : labelTierForWidth(width)

  const geometry = useMemo(
    () => layout({ dimensions, parametersByDimension, contexts, bindingsByContext }),
    [dimensions, parametersByDimension, contexts, bindingsByContext],
  )

  const isEmpty = contexts.length === 0

  return (
    <div className="canvas-shell" data-label-tier={labelTier} ref={shellRef}>
      <svg
        className="canvas-svg"
        viewBox={geometry.viewBox}
        role="img"
        aria-label="Context canvas"
        data-empty={isEmpty}
      >
        {geometry.arcs.map((arc) => (
          <g key={arc.dimensionId}>
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

        {geometry.dots.map((dot) => (
          <circle
            key={`${dot.dimensionId}:${dot.parameterId}`}
            className="canvas-dot"
            data-dimension-id={dot.dimensionId}
            data-parameter-id={dot.parameterId}
            cx={dot.x}
            cy={dot.y}
            r={5}
            style={{ fill: dot.color }}
          />
        ))}

        {geometry.nodes.map((node) => (
          <g
            key={node.contextId}
            className={node.isDraft ? 'canvas-node canvas-node--draft' : 'canvas-node'}
            data-context-id={node.contextId}
          >
            <circle cx={node.x} cy={node.y} r={NODE_RADIUS} />
            <text x={node.x} y={node.y} textAnchor="middle" dominantBaseline="central">
              {node.symbol}
            </text>
            {node.childCount > 0 ? (
              <text className="canvas-node-badge" x={node.x + NODE_RADIUS} y={node.y - NODE_RADIUS}>
                {node.childCount}
              </text>
            ) : null}
          </g>
        ))}

        {isEmpty ? (
          <text className="canvas-empty-prompt" x={500} y={500} textAnchor="middle">
            Bind your first context
          </text>
        ) : null}
      </svg>
    </div>
  )
}
