// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
        selectedContextId={null}
        onSelect={() => {}}
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
        selectedContextId={null}
        onSelect={() => {}}
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
        selectedContextId={null}
        onSelect={() => {}}
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
        selectedContextId={null}
        onSelect={() => {}}
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
          selectedContextId={null}
          onSelect={() => {}}
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

  describe('selection (issue 009)', () => {
    // Two dims only (d2 has zero params, so it can never be bound — same
    // rationale as the draft-node fixture above); ctxA fully bound (d0/d1),
    // ctxB missing d1 (draft).
    const selDims = [dim('d0', 0), dim('d1', 1)]
    const selBindings = { ctxA: { d0: 'd0-p0', d1: 'd1-p0' }, ctxB: { d0: 'd0-p1' } }

    function renderCanvas(selectedContextId: string | null, onSelect: (id: string | null) => void = () => {}) {
      return render(
        <Canvas
          dimensions={selDims}
          parametersByDimension={parametersByDimension}
          contexts={contexts}
          bindingsByContext={selBindings}
          selectedContextId={selectedContextId}
          onSelect={onSelect}
        />,
      )
    }

    it('clicking a node calls onSelect with its context id', async () => {
      const user = userEvent.setup()
      const onSelect = vi.fn()
      const { container } = renderCanvas(null, onSelect)
      await user.click(container.querySelector('[data-context-id="ctxA"]') as Element)
      expect(onSelect).toHaveBeenCalledExactlyOnceWith('ctxA')
    })

    it('gives the selected node an aria-label describing symbol, tuple, and status', () => {
      const { container } = renderCanvas('ctxB')
      const node = container.querySelector('[data-context-id="ctxB"]')
      expect(node).toHaveAttribute('aria-label', 'β — d0-p1, —, draft')
    })

    it('dims every non-selected node when a selection exists; the selected node is never dimmed', () => {
      const { container } = renderCanvas('ctxA')
      expect(container.querySelector('[data-context-id="ctxA"]')).not.toHaveClass('canvas-node--dimmed')
      expect(container.querySelector('[data-context-id="ctxB"]')).toHaveClass('canvas-node--dimmed')
    })

    it('draws no dimming when nothing is selected', () => {
      const { container } = renderCanvas(null)
      expect(container.querySelectorAll('.canvas-node--dimmed')).toHaveLength(0)
    })

    it('draws one spoke per bound dimension of the selected context, colored by dimension; none for unbound', () => {
      const { container } = renderCanvas('ctxB') // ctxB binds only d0
      expect(container.querySelectorAll('.canvas-spoke')).toHaveLength(1)
      const spoke = container.querySelector('.canvas-spoke') as HTMLElement
      expect(spoke.getAttribute('data-dimension-id')).toBe('d0')
    })

    it('draws no spokes when nothing is selected', () => {
      const { container } = renderCanvas(null)
      expect(container.querySelectorAll('.canvas-spoke')).toHaveLength(0)
    })

    it('roving tabIndex: the selected node is the only tab stop; the first node is the default when none is selected', () => {
      const { container: none } = renderCanvas(null)
      expect(none.querySelector('[data-context-id="ctxA"]')).toHaveAttribute('tabindex', '0')
      expect(none.querySelector('[data-context-id="ctxB"]')).toHaveAttribute('tabindex', '-1')

      const { container: withB } = renderCanvas('ctxB')
      expect(withB.querySelector('[data-context-id="ctxA"]')).toHaveAttribute('tabindex', '-1')
      expect(withB.querySelector('[data-context-id="ctxB"]')).toHaveAttribute('tabindex', '0')
    })

    it('ArrowRight/ArrowDown selects the next node in layout order, wrapping past the last', async () => {
      const user = userEvent.setup()
      const onSelect = vi.fn()
      const { container } = renderCanvas('ctxA', onSelect)
      const nodeA = container.querySelector('[data-context-id="ctxA"]') as HTMLElement
      nodeA.focus()
      await user.keyboard('{ArrowRight}')
      expect(onSelect).toHaveBeenCalledExactlyOnceWith('ctxB')

      onSelect.mockClear()
      const { container: c2 } = renderCanvas('ctxB', onSelect)
      const nodeB = c2.querySelector('[data-context-id="ctxB"]') as HTMLElement
      nodeB.focus()
      await user.keyboard('{ArrowDown}')
      expect(onSelect).toHaveBeenCalledExactlyOnceWith('ctxA') // wraps
    })

    it('ArrowLeft/ArrowUp selects the previous node, wrapping past the first', async () => {
      const user = userEvent.setup()
      const onSelect = vi.fn()
      const { container } = renderCanvas('ctxA', onSelect)
      const nodeA = container.querySelector('[data-context-id="ctxA"]') as HTMLElement
      nodeA.focus()
      await user.keyboard('{ArrowLeft}')
      expect(onSelect).toHaveBeenCalledExactlyOnceWith('ctxB') // wraps
    })

    it('Escape clears the selection', async () => {
      const user = userEvent.setup()
      const onSelect = vi.fn()
      const { container } = renderCanvas('ctxA', onSelect)
      const nodeA = container.querySelector('[data-context-id="ctxA"]') as HTMLElement
      nodeA.focus()
      await user.keyboard('{Escape}')
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(null)
    })

    it('clicking the canvas background (not a node) clears the selection', async () => {
      const user = userEvent.setup()
      const onSelect = vi.fn()
      const { container } = renderCanvas('ctxA', onSelect)
      await user.click(container.querySelector('.canvas-svg') as Element)
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(null)
    })

    it('clicking a node does not also clear the selection via background-click bubbling', async () => {
      const user = userEvent.setup()
      const onSelect = vi.fn()
      const { container } = renderCanvas(null, onSelect)
      await user.click(container.querySelector('[data-context-id="ctxA"]') as Element)
      expect(onSelect).toHaveBeenCalledExactlyOnceWith('ctxA')
    })
  })

  describe('compose mode (issue 010)', () => {
    // Two dims with real parameters so dots exist to click; ctxDraft is the
    // context being composed (starts unbound).
    const composeDims = [dim('d0', 0), dim('d1', 1)]
    const composeParams = {
      d0: [param('d0', 'd0-p0', 0), param('d0', 'd0-p1', 1)],
      d1: [param('d1', 'd1-p0', 0)],
    }
    const draft = ctx('draft', 'γ')

    function renderCompose(
      opts: {
        composeContextId?: string | null
        bindings?: Record<string, Record<string, string>>
        activeDimensionId?: string | null
        onBindParameter?: (dimensionId: string, parameterId: string) => void
        onUnbindParameter?: (dimensionId: string) => void
        onExitCompose?: () => void
      } = {},
    ) {
      return render(
        <Canvas
          dimensions={composeDims}
          parametersByDimension={composeParams}
          contexts={[draft]}
          bindingsByContext={opts.bindings ?? { draft: {} }}
          selectedContextId={opts.composeContextId ?? 'draft'}
          onSelect={() => {}}
          composeContextId={opts.composeContextId ?? null}
          activeDimensionId={opts.activeDimensionId ?? null}
          onBindParameter={opts.onBindParameter ?? (() => {})}
          onUnbindParameter={opts.onUnbindParameter ?? (() => {})}
          onExitCompose={opts.onExitCompose ?? (() => {})}
        />,
      )
    }

    it('read mode: clicking a parameter dot never binds (no hit circle, no mutation)', async () => {
      const user = userEvent.setup()
      const onBindParameter = vi.fn()
      const { container } = renderCompose({ composeContextId: null, onBindParameter })
      expect(container.querySelectorAll('.canvas-dot-hit')).toHaveLength(0)
      await user.click(container.querySelector('.canvas-dot[data-parameter-id="d0-p0"]') as Element)
      expect(onBindParameter).not.toHaveBeenCalled()
    })

    it('compose mode: clicking an unbound dot binds its dimension to that parameter', async () => {
      const user = userEvent.setup()
      const onBindParameter = vi.fn()
      const { container } = renderCompose({ composeContextId: 'draft', onBindParameter })
      const group = container.querySelector('.canvas-dot-group[data-parameter-id="d0-p0"]') as Element
      await user.click(group.querySelector('.canvas-dot-hit') as Element)
      expect(onBindParameter).toHaveBeenCalledExactlyOnceWith('d0', 'd0-p0')
    })

    it('compose mode: clicking the currently-bound dot unbinds that dimension', async () => {
      const user = userEvent.setup()
      const onUnbindParameter = vi.fn()
      const onBindParameter = vi.fn()
      const { container } = renderCompose({
        composeContextId: 'draft',
        bindings: { draft: { d0: 'd0-p0' } },
        onBindParameter,
        onUnbindParameter,
      })
      const group = container.querySelector('.canvas-dot-group[data-parameter-id="d0-p0"]') as Element
      await user.click(group.querySelector('.canvas-dot-hit') as Element)
      expect(onUnbindParameter).toHaveBeenCalledExactlyOnceWith('d0')
      expect(onBindParameter).not.toHaveBeenCalled()
    })

    it('compose mode: the bound dot carries the bound affordance class; unbound dots do not', () => {
      const { container } = renderCompose({
        composeContextId: 'draft',
        bindings: { draft: { d0: 'd0-p0' } },
      })
      expect(container.querySelector('.canvas-dot-group[data-parameter-id="d0-p0"]')).toHaveClass(
        'canvas-dot-group--bound',
      )
      expect(container.querySelector('.canvas-dot-group[data-parameter-id="d0-p1"]')).not.toHaveClass(
        'canvas-dot-group--bound',
      )
    })

    it('compose mode: every dot exposes an invisible hit circle sized to the measured canvas width', () => {
      // Fake ResizeObserver → 500px measured width → 44-unit hit radius.
      type ResizeCallback = (entries: { contentRect: { width: number } }[]) => void
      let observed: ResizeCallback | null = null
      const Original = window.ResizeObserver
      window.ResizeObserver = function (cb: ResizeCallback) {
        observed = cb
        return { observe: () => {}, unobserve: () => {}, disconnect: () => {} }
      } as unknown as typeof ResizeObserver
      try {
        const { container } = renderCompose({ composeContextId: 'draft' })
        act(() => observed?.([{ contentRect: { width: 500 } }]))
        const hit = container.querySelector('.canvas-dot-hit') as SVGCircleElement
        expect(hit).not.toBeNull()
        expect(Number(hit.getAttribute('r'))).toBeCloseTo(44)
      } finally {
        window.ResizeObserver = Original
      }
    })

    it('compose mode: the active dimension is marked so its labels read at full strength', () => {
      const { container } = renderCompose({ composeContextId: 'draft', activeDimensionId: 'd1' })
      expect(container.querySelector('.canvas-arc-group[data-dimension-id="d1"]')).toHaveAttribute(
        'data-active',
        'true',
      )
      expect(container.querySelector('.canvas-arc-group[data-dimension-id="d0"]')).toHaveAttribute(
        'data-active',
        'false',
      )
    })

    it('compose mode: Escape exits compose (keeps the draft) instead of clearing selection', async () => {
      const user = userEvent.setup()
      const onExitCompose = vi.fn()
      const onSelect = vi.fn()
      const { container } = render(
        <Canvas
          dimensions={composeDims}
          parametersByDimension={composeParams}
          contexts={[draft]}
          bindingsByContext={{ draft: {} }}
          selectedContextId="draft"
          onSelect={onSelect}
          composeContextId="draft"
          activeDimensionId="d0"
          onExitCompose={onExitCompose}
        />,
      )
      const node = container.querySelector('[data-context-id="draft"]') as HTMLElement
      node.focus()
      await user.keyboard('{Escape}')
      expect(onExitCompose).toHaveBeenCalledOnce()
      expect(onSelect).not.toHaveBeenCalledWith(null)
    })
  })
})
