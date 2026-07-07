// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Canvas, type CanvasProps } from './Canvas'
import type { CanvasEmphasis } from '../domain/canvasAdjacency'
import type { ContextRow, DimensionRow, ParameterRow } from '../db/mutations'

function dim(id: string, sort: number, color = '#6f5bd6'): DimensionRow {
  return {
    id,
    projectId: 'proj1',
    workspaceId: 'ws1',
    contextId: null,
    sourceParamId: null,
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
    sourceEntryId: null,
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
    workspaceId: 'ws1',
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

    // Issue 039 (028 phase b) — spokes are now bundled splines (a <path>
    // built by the pure spokePath), not straight <line>s. Same count, same
    // class/data-attributes (028a + every pre-existing spoke-counting spec
    // keep working); only the tag and the presence of a curve command in `d`
    // change.
    it('renders spokes as <path> elements with a bundled (curved) d attribute, not straight <line>s', () => {
      const { container } = renderCanvas('ctxA') // ctxA is fully bound: d0 + d1
      const spokes = container.querySelectorAll('.canvas-spoke')
      expect(spokes).toHaveLength(2)
      expect(container.querySelectorAll('line.canvas-spoke')).toHaveLength(0)
      for (const spoke of Array.from(spokes)) {
        expect(spoke.tagName.toLowerCase()).toBe('path')
        const d = spoke.getAttribute('d') ?? ''
        expect(d.length).toBeGreaterThan(0)
        expect(d).toMatch(/[QC]/)
      }
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

  describe('drill-in (issue 011)', () => {
    const drillDims = [dim('d0', 0), dim('d1', 1)]
    const drillBindings = { ctxA: { d0: 'd0-p0', d1: 'd1-p0' }, ctxB: { d0: 'd0-p1', d1: 'd1-p0' } }

    it('double-clicking a node drills into its child canvas', async () => {
      const user = userEvent.setup()
      const onDrillIn = vi.fn()
      const { container } = render(
        <Canvas
          dimensions={drillDims}
          parametersByDimension={parametersByDimension}
          contexts={contexts}
          bindingsByContext={drillBindings}
          selectedContextId={null}
          onSelect={() => {}}
          onDrillIn={onDrillIn}
        />,
      )
      await user.dblClick(container.querySelector('[data-context-id="ctxA"]') as Element)
      expect(onDrillIn).toHaveBeenCalledExactlyOnceWith('ctxA')
    })

    it('Enter on a focused node drills in', async () => {
      const user = userEvent.setup()
      const onDrillIn = vi.fn()
      const { container } = render(
        <Canvas
          dimensions={drillDims}
          parametersByDimension={parametersByDimension}
          contexts={contexts}
          bindingsByContext={drillBindings}
          selectedContextId="ctxB"
          onSelect={() => {}}
          onDrillIn={onDrillIn}
        />,
      )
      const node = container.querySelector('[data-context-id="ctxB"]') as HTMLElement
      node.focus()
      await user.keyboard('{Enter}')
      expect(onDrillIn).toHaveBeenCalledExactlyOnceWith('ctxB')
    })

    it('shows a child badge from the supplied per-context child counts', () => {
      const { container } = render(
        <Canvas
          dimensions={drillDims}
          parametersByDimension={parametersByDimension}
          contexts={contexts}
          bindingsByContext={drillBindings}
          selectedContextId={null}
          onSelect={() => {}}
          childCountByContext={{ ctxA: 3 }}
        />,
      )
      const badge = container.querySelector('[data-context-id="ctxA"] .canvas-node-badge')
      expect(badge?.textContent).toBe('3')
      expect(container.querySelector('[data-context-id="ctxB"] .canvas-node-badge')).toBeNull()
    })
  })

  describe('parameter dots + labels (issue 023)', () => {
    const paramDims = [dim('dA', 0), dim('dB', 1)]
    const paramParams = {
      dA: [param('dA', 'dA-p0', 0), param('dA', 'ReallyLongParamName', 1)],
      dB: [param('dB', 'dB-p0', 0), param('dB', 'dB-p1', 1)],
    }

    it('renders one label per parameter dot with its name, and a legible dot radius', () => {
      // jsdom's real (unmocked) ResizeObserver never fires, and the initial
      // mount measurement (`getBoundingClientRect().width`) is 0 in jsdom, not
      // null — so the tier defaults to 'legend' unless a width is supplied
      // the same way the responsive-tier tests below do.
      type ResizeCallback = (entries: { contentRect: { width: number } }[]) => void
      let observed: ResizeCallback | null = null
      const Original = window.ResizeObserver
      window.ResizeObserver = function (cb: ResizeCallback) {
        observed = cb
        return { observe: () => {}, unobserve: () => {}, disconnect: () => {} }
      } as unknown as typeof ResizeObserver
      try {
        const { container } = render(
          <Canvas
            dimensions={paramDims}
            parametersByDimension={paramParams}
            contexts={[]}
            bindingsByContext={{}}
            selectedContextId={null}
            onSelect={() => {}}
          />,
        )
        act(() => observed?.([{ contentRect: { width: 800 } }]))

        const labels = Array.from(container.querySelectorAll('.canvas-param-label'))
        expect(labels).toHaveLength(4)
        expect(labels.map((l) => l.textContent).sort()).toEqual(
          ['dA-p0', 'ReallyLongParamName', 'dB-p0', 'dB-p1'].sort(),
        )

        const dotEl = container.querySelector('.canvas-dot') as SVGCircleElement
        // Legibility bump (issue 023 bug report: the original r=5 measured
        // ~2-4px on screen). Above 5 is a meaningful, testable floor.
        expect(Number(dotEl.getAttribute('r'))).toBeGreaterThan(5)
      } finally {
        window.ResizeObserver = Original
      }
    })

    it('degrades labels per the responsive tier: full text ≥640, truncated 400-640, hidden <400', () => {
      type ResizeCallback = (entries: { contentRect: { width: number } }[]) => void
      let observed: ResizeCallback | null = null
      const Original = window.ResizeObserver
      window.ResizeObserver = function (cb: ResizeCallback) {
        observed = cb
        return { observe: () => {}, unobserve: () => {}, disconnect: () => {} }
      } as unknown as typeof ResizeObserver
      try {
        const { container } = render(
          <Canvas
            dimensions={paramDims}
            parametersByDimension={paramParams}
            contexts={[]}
            bindingsByContext={{}}
            selectedContextId={null}
            onSelect={() => {}}
          />,
        )

        act(() => observed?.([{ contentRect: { width: 800 } }]))
        expect(screen.getByText('ReallyLongParamName')).toBeInTheDocument()

        act(() => observed?.([{ contentRect: { width: 500 } }]))
        expect(screen.queryByText('ReallyLongParamName')).not.toBeInTheDocument()
        expect(container.querySelectorAll('.canvas-param-label').length).toBeGreaterThan(0)

        act(() => observed?.([{ contentRect: { width: 300 } }]))
        expect(container.querySelectorAll('.canvas-param-label')).toHaveLength(0)
      } finally {
        window.ResizeObserver = Original
      }
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

    it('read mode: clicking a parameter dot never binds (no click handler, no mutation)', async () => {
      const user = userEvent.setup()
      const onBindParameter = vi.fn()
      const { container } = renderCompose({ composeContextId: null, onBindParameter })
      // Issue 028(a) — the invisible hit circle now renders in read mode too
      // (a real hover/focus target, STYLE_GUIDE §7's pre-existing ≥44px
      // touch-target rule); what read mode still never has is a click
      // handler wired to it, so clicking it can never mutate.
      expect(container.querySelectorAll('.canvas-dot-hit').length).toBeGreaterThan(0)
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

  describe('focus + adjacency (issue 028)', () => {
    // Two dims, both with real parameters, so there's something to mute on
    // every role. ctxA binds d0-p0 + d1-p0; ctxB binds d0-p1 + d1-p0 (shares
    // d1-p0 with ctxA — the "who else uses this parameter" case).
    const focusDims = [dim('d0', 0), dim('d1', 1)]
    const focusParams = {
      d0: [param('d0', 'd0-p0', 0), param('d0', 'd0-p1', 1)],
      d1: [param('d1', 'd1-p0', 0)],
    }
    const focusContexts = [ctx('ctxA', 'α'), ctx('ctxB', 'β')]
    const focusBindings = {
      ctxA: { d0: 'd0-p0', d1: 'd1-p0' },
      ctxB: { d0: 'd0-p1', d1: 'd1-p0' },
    }

    // Canvas is fully controlled for hover/focus (hoveredMark + onHoverChange
    // — mirrors selectedContextId/onSelect exactly): the real owner is
    // DesignSurface's own useState. Exercising hover/focus in a unit test
    // therefore needs a tiny stateful harness playing that role, otherwise
    // `onHoverChange` fires into the void and the prop never actually
    // updates — this is the correct behaviour of a controlled component, not
    // a gap in Canvas itself.
    function CanvasHarness(props: Partial<CanvasProps>) {
      const [hoveredMark, setHoveredMark] = useState<CanvasEmphasis | null>(null)
      return (
        <Canvas
          dimensions={focusDims}
          parametersByDimension={focusParams}
          contexts={focusContexts}
          bindingsByContext={focusBindings}
          selectedContextId={null}
          onSelect={() => {}}
          hoveredMark={hoveredMark}
          onHoverChange={setHoveredMark}
          {...props}
        />
      )
    }

    function renderFocus(overrides: Partial<CanvasProps> = {}) {
      return render(<CanvasHarness {...overrides} />)
    }

    it('resting state (no hover, no selection) carries .canvas--muted nowhere', () => {
      const { container } = renderFocus()
      expect(container.querySelectorAll('.canvas--muted')).toHaveLength(0)
    })

    it('hovering a context node mutes non-adjacent dots/arcs/nodes; mouseleave clears it', async () => {
      const user = userEvent.setup()
      const { container } = renderFocus()
      const nodeA = container.querySelector('[data-context-id="ctxA"]') as HTMLElement
      await user.hover(nodeA)

      expect(container.querySelector('[data-parameter-id="d0-p0"].canvas-dot-group')).not.toHaveClass(
        'canvas--muted',
      )
      expect(container.querySelector('[data-parameter-id="d1-p0"].canvas-dot-group')).not.toHaveClass(
        'canvas--muted',
      )
      expect(container.querySelector('[data-parameter-id="d0-p1"].canvas-dot-group')).toHaveClass('canvas--muted')
      expect(container.querySelector('[data-context-id="ctxA"]')).not.toHaveClass('canvas--muted')
      expect(container.querySelector('[data-context-id="ctxB"]')).toHaveClass('canvas--muted')
      // Context adjacency has no dimensions of its own — both arcs mute.
      expect(container.querySelector('.canvas-arc-group[data-dimension-id="d0"]')).toHaveClass('canvas--muted')
      expect(container.querySelector('.canvas-arc-group[data-dimension-id="d1"]')).toHaveClass('canvas--muted')

      await user.unhover(nodeA)
      expect(container.querySelectorAll('.canvas--muted')).toHaveLength(0)
    })

    it('hovering a parameter dot keeps it and its bound contexts (+ their spokes) unmuted', async () => {
      const user = userEvent.setup()
      const { container } = renderFocus()
      const dot = container.querySelector('.canvas-dot-group[data-parameter-id="d1-p0"]') as HTMLElement
      await user.hover(dot)

      // d1-p0 is bound by both contexts.
      expect(container.querySelector('[data-context-id="ctxA"]')).not.toHaveClass('canvas--muted')
      expect(container.querySelector('[data-context-id="ctxB"]')).not.toHaveClass('canvas--muted')
      expect(container.querySelectorAll('.canvas-spoke')).toHaveLength(4) // 2 contexts x 2 bound dims

      // The hovered dot itself is never muted, even though the pure predicate
      // doesn't return a parameter's own dot key (Canvas's self-check).
      expect(dot).not.toHaveClass('canvas--muted')
      expect(container.querySelector('[data-parameter-id="d0-p0"].canvas-dot-group')).toHaveClass('canvas--muted')
      expect(container.querySelector('.canvas-arc-group[data-dimension-id="d0"]')).toHaveClass('canvas--muted')

      await user.unhover(dot)
      expect(container.querySelectorAll('.canvas--muted')).toHaveLength(0)
    })

    it('hovering a dimension arc keeps its dots and bound contexts unmuted', async () => {
      const user = userEvent.setup()
      const { container } = renderFocus()
      const arc = container.querySelector('.canvas-arc-group[data-dimension-id="d0"]') as HTMLElement
      await user.hover(arc)

      expect(arc).not.toHaveClass('canvas--muted')
      expect(container.querySelector('.canvas-arc-group[data-dimension-id="d1"]')).toHaveClass('canvas--muted')
      expect(container.querySelector('[data-parameter-id="d0-p0"].canvas-dot-group')).not.toHaveClass(
        'canvas--muted',
      )
      expect(container.querySelector('[data-parameter-id="d0-p1"].canvas-dot-group')).not.toHaveClass(
        'canvas--muted',
      )
      expect(container.querySelector('[data-parameter-id="d1-p0"].canvas-dot-group')).toHaveClass('canvas--muted')
      expect(container.querySelector('[data-context-id="ctxA"]')).not.toHaveClass('canvas--muted')
      expect(container.querySelector('[data-context-id="ctxB"]')).not.toHaveClass('canvas--muted')

      await user.unhover(arc)
      expect(container.querySelectorAll('.canvas--muted')).toHaveLength(0)
    })

    it('keyboard focus on a node produces the same emphasis as hover; blur clears it', () => {
      const { container } = renderFocus()
      const nodeA = container.querySelector('[data-context-id="ctxA"]') as HTMLElement
      act(() => nodeA.focus())
      expect(container.querySelector('[data-context-id="ctxB"]')).toHaveClass('canvas--muted')
      act(() => nodeA.blur())
      expect(container.querySelectorAll('.canvas--muted')).toHaveLength(0)
    })

    it('keyboard focus on a parameter dot produces the same emphasis as hover; blur clears it', () => {
      const { container } = renderFocus()
      const dot = container.querySelector('.canvas-dot-group[data-parameter-id="d0-p1"]') as HTMLElement
      act(() => dot.focus())
      expect(container.querySelector('[data-context-id="ctxB"]')).not.toHaveClass('canvas--muted') // binds d0-p1
      expect(container.querySelector('[data-context-id="ctxA"]')).toHaveClass('canvas--muted')
      act(() => dot.blur())
      expect(container.querySelectorAll('.canvas--muted')).toHaveLength(0)
    })

    it('a locked selection composes with a transient hover: hovering elsewhere never calls onSelect and previews, then falls back on unhover', async () => {
      const user = userEvent.setup()
      const onSelect = vi.fn()
      const { container } = renderFocus({ selectedContextId: 'ctxA', onSelect })

      // Resting-with-a-locked-selection already mutes non-adjacent marks
      // (the "hover ?? selection" fallback).
      expect(container.querySelector('[data-context-id="ctxB"]')).toHaveClass('canvas--muted')

      const dot = container.querySelector('.canvas-dot-group[data-parameter-id="d1-p0"]') as HTMLElement
      await user.hover(dot)
      // d1-p0 is bound by both contexts — the hover preview un-mutes ctxB
      // without ever touching the lock.
      expect(container.querySelector('[data-context-id="ctxB"]')).not.toHaveClass('canvas--muted')
      expect(onSelect).not.toHaveBeenCalled()

      await user.unhover(dot)
      expect(container.querySelector('[data-context-id="ctxB"]')).toHaveClass('canvas--muted')
    })

    it('does not apply hover-driven muting while composing (existing active-dimension dimming is unaffected)', async () => {
      const user = userEvent.setup()
      const { container } = renderFocus({
        composeContextId: 'ctxA',
        activeDimensionId: 'd1',
        selectedContextId: 'ctxA',
      })
      const dot = container.querySelector('.canvas-dot-group[data-parameter-id="d0-p0"]') as HTMLElement
      await user.hover(dot)
      expect(container.querySelectorAll('.canvas--muted')).toHaveLength(0)
    })
  })
})
