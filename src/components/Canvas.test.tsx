// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { Canvas } from './Canvas'
import type { ContextRow, DimensionRow, ParameterRow } from '../db/mutations'

function dim(id: string, sort: number, color = '#6f5bd6'): DimensionRow {
  return {
    id,
    projectId: 'proj1',
    contextId: null,
    name: id,
    color,
    sort,
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
  }
}

function param(dimensionId: string, id: string, sort: number): ParameterRow {
  return {
    id,
    dimensionId,
    parentParamId: null,
    name: id,
    sort,
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
  }
}

function ctx(id: string, symbol: string): ContextRow {
  return {
    id,
    projectId: 'proj1',
    parentId: null,
    symbol,
    name: null,
    justification: null,
    sort: 0,
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
  }
}

const dimensions = [dim('d0', 0), dim('d1', 1), dim('d2', 2)]
const parametersByDimension = {
  d0: [param('d0', 'd0-p0', 0), param('d0', 'd0-p1', 1)],
  d1: [param('d1', 'd1-p0', 0)],
  d2: [], // zero-parameter dimension
}
const contexts = [ctx('ctxA', 'α'), ctx('ctxB', 'β')]
const bindingsByContext = {
  ctxA: { d0: 'd0-p0', d1: 'd1-p0' }, // missing d2 -> draft (d2 has no params anyway)
  ctxB: { d0: 'd0-p1', d1: 'd1-p0' },
}

describe('Canvas', () => {
  it('renders one arc per dimension, one dot per parameter, and one node per context', () => {
    const { container } = render(
      <Canvas
        dimensions={dimensions}
        parametersByDimension={parametersByDimension}
        contexts={contexts}
        bindingsByContext={bindingsByContext}
      />,
    )
    expect(container.querySelectorAll('.canvas-arc')).toHaveLength(3)
    expect(container.querySelectorAll('.canvas-dot')).toHaveLength(3) // 2 + 1 + 0
    expect(container.querySelectorAll('.canvas-node')).toHaveLength(2)
  })

  it('marks the zero-parameter dimension arc as empty, with no dots for it', () => {
    const { container } = render(
      <Canvas
        dimensions={dimensions}
        parametersByDimension={parametersByDimension}
        contexts={contexts}
        bindingsByContext={bindingsByContext}
      />,
    )
    const emptyArc = container.querySelector('.canvas-arc[data-dimension-id="d2"]')
    expect(emptyArc).toHaveAttribute('data-empty', 'true')
  })

  it('renders a draft context node with the dashed-ring class', () => {
    // Only d0/d1 here — d2 has zero parameters, so binding it is impossible;
    // including it would make every context draft regardless of d0/d1.
    const twoDims = [dim('d0', 0), dim('d1', 1)]
    const { container } = render(
      <Canvas
        dimensions={twoDims}
        parametersByDimension={parametersByDimension}
        contexts={contexts}
        bindingsByContext={{ ctxA: { d0: 'd0-p0' }, ctxB: { d0: 'd0-p1', d1: 'd1-p0' } }}
      />,
    )
    const draftNode = container.querySelector('[data-context-id="ctxA"]')
    expect(draftNode).toHaveClass('canvas-node--draft')
    const completeNode = container.querySelector('[data-context-id="ctxB"]')
    expect(completeNode).not.toHaveClass('canvas-node--draft')
  })

  it('shows the empty-state prompt when there are no contexts yet', () => {
    render(
      <Canvas
        dimensions={dimensions}
        parametersByDimension={parametersByDimension}
        contexts={[]}
        bindingsByContext={{}}
      />,
    )
    expect(screen.getByText('Bind your first context')).toBeInTheDocument()
  })

  describe('responsive label tiers', () => {
    type ResizeCallback = (entries: { contentRect: { width: number } }[]) => void
    let observed: ResizeCallback | null = null
    const OriginalResizeObserver = window.ResizeObserver

    beforeEach(() => {
      observed = null
      function FakeResizeObserver(cb: ResizeCallback) {
        observed = cb
        return { observe: () => {}, unobserve: () => {}, disconnect: () => {} }
      }
      window.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
    })

    afterEach(() => {
      window.ResizeObserver = OriginalResizeObserver
    })

    it('switches the label tier attribute as the measured container width crosses 640px/400px', () => {
      const { container } = render(
        <Canvas
          dimensions={dimensions}
          parametersByDimension={parametersByDimension}
          contexts={contexts}
          bindingsByContext={bindingsByContext}
        />,
      )
      const shell = container.querySelector('.canvas-shell')
      expect(shell).not.toBeNull()

      act(() => observed?.([{ contentRect: { width: 800 } }]))
      expect(shell).toHaveAttribute('data-label-tier', 'full')

      act(() => observed?.([{ contentRect: { width: 500 } }]))
      expect(shell).toHaveAttribute('data-label-tier', 'truncated')

      act(() => observed?.([{ contentRect: { width: 300 } }]))
      expect(shell).toHaveAttribute('data-label-tier', 'legend')
    })
  })
})
