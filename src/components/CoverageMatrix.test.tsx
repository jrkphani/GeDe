// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ContextRow, DimensionRow, ParameterRow } from '../db/mutations'
import { CoverageMatrix } from './CoverageMatrix'

const dim = (id: string, name: string, sort: number): DimensionRow =>
  ({ id, projectId: 'p', name, color: '#2d6a4f', sort }) as unknown as DimensionRow
const param = (id: string, name: string, sort: number): ParameterRow =>
  ({ id, dimensionId: '', name, sort }) as unknown as ParameterRow
const ctx = (id: string, symbol: string, justification: string | null): ContextRow =>
  ({ id, projectId: 'p', symbol, name: null, justification, sort: 0 }) as unknown as ContextRow

// Canvas: dims A, B, C — each two parameters. Default axes = two largest, ties
// by sort → rows A, cols B; C becomes a filter chip.
function baseProps(overrides: Partial<Parameters<typeof CoverageMatrix>[0]> = {}) {
  return {
    dimensions: [dim('A', 'Aim', 0), dim('B', 'Bay', 1), dim('C', 'Cue', 2)],
    parametersByDimension: {
      A: [param('pA1', 'A1', 0), param('pA2', 'A2', 1)],
      B: [param('pB1', 'B1', 0), param('pB2', 'B2', 1)],
      C: [param('pC1', 'C1', 0), param('pC2', 'C2', 1)],
    },
    contexts: [] as ContextRow[],
    bindingsByContext: {} as Record<string, Record<string, string>>,
    selectedContextId: null,
    onSelectContext: vi.fn(),
    onComposeTuple: vi.fn(),
    ...overrides,
  }
}

describe('CoverageMatrix (issue 012)', () => {
  it('shows the live stat and renders documented vs hollow cells', () => {
    const props = baseProps({
      contexts: [ctx('c1', 'α', 'because')],
      bindingsByContext: { c1: { A: 'pA1', B: 'pB1', C: 'pC1' } },
    })
    const { container } = render(<CoverageMatrix {...props} />)

    // Stat: ∏ mᵢ = 8, one documented tuple.
    expect(screen.getByText('1 / 8 documented')).toBeInTheDocument()

    const documented = container.querySelectorAll('[data-documented="true"]')
    expect(documented).toHaveLength(1)
    expect(documented[0]).toHaveTextContent('α')
    // The A1×B1 cell on the default C1 page carries the symbol.
    expect(documented[0]?.getAttribute('aria-label')).toContain('A1 · B1 · C1')

    // The rest of the page is hollow (4 cells on a 2×2 page, 1 documented).
    expect(container.querySelectorAll('[data-documented="false"]')).toHaveLength(3)
  })

  it('clicking a hollow cell composes the full tuple', async () => {
    const user = userEvent.setup()
    const props = baseProps()
    render(<CoverageMatrix {...props} />)

    await user.click(screen.getByLabelText('Unexplored — A2 · B1 · C1'))
    expect(props.onComposeTuple).toHaveBeenCalledWith({ A: 'pA2', B: 'pB1', C: 'pC1' })
  })

  it('clicking a documented cell selects that context', async () => {
    const user = userEvent.setup()
    const props = baseProps({
      contexts: [ctx('c1', 'α', 'because')],
      bindingsByContext: { c1: { A: 'pA1', B: 'pB1', C: 'pC1' } },
    })
    render(<CoverageMatrix {...props} />)

    await user.click(screen.getByLabelText('α — A1 · B1 · C1'))
    expect(props.onSelectContext).toHaveBeenCalledWith('c1')
  })

  it('stacks duplicate contexts in one cell', () => {
    const props = baseProps({
      contexts: [ctx('c1', 'α', 'j'), ctx('c2', 'β', 'j')],
      bindingsByContext: {
        c1: { A: 'pA1', B: 'pB1', C: 'pC1' },
        c2: { A: 'pA1', B: 'pB1', C: 'pC1' },
      },
    })
    const { container } = render(<CoverageMatrix {...props} />)

    const stacked = container.querySelector('[data-stacked]')
    expect(stacked).not.toBeNull()
    expect(stacked?.getAttribute('data-count')).toBe('2')
    expect(stacked?.getAttribute('aria-label')).toContain('α, β')
    // Still one documented tuple in the stat.
    expect(screen.getByText('1 / 8 documented')).toBeInTheDocument()
  })

  it('swapping axes preserves the filter selection', async () => {
    const user = userEvent.setup()
    const props = baseProps()
    const { container } = render(<CoverageMatrix {...props} />)

    // Change the C filter chip from C1 to C2.
    await user.click(screen.getByRole('button', { name: /Cue:/ }))
    await user.click(screen.getByText('C2'))
    // Cells now sit on the C2 page.
    expect(container.querySelector('[aria-label*="· C2"]')).not.toBeNull()

    // Swap the row/column axes; the C2 filter must survive the swap.
    await user.click(screen.getByRole('button', { name: 'Swap axes' }))
    expect(container.querySelector('[aria-label*="· C2"]')).not.toBeNull()
    expect(container.querySelector('[aria-label*="· C1"]')).toBeNull()
  })

  it('virtualizes: a ∏ mᵢ ≈ 10,000 space mounts only a windowed slice of cells', () => {
    const big = (prefix: string) => Array.from({ length: 100 }, (_, i) => param(`${prefix}${i}`, `${prefix}${i}`, i))
    const props = baseProps({
      dimensions: [dim('A', 'Aim', 0), dim('B', 'Bay', 1)],
      parametersByDimension: { A: big('a'), B: big('b') },
    })
    const { container } = render(<CoverageMatrix {...props} />)

    // Denominator is the full 10,000-tuple space...
    expect(screen.getByText('0 / 10000 documented')).toBeInTheDocument()
    // ...but only a viewport-sized window of cells is in the DOM (never 10k).
    const mounted = container.querySelectorAll('.coverage-cell').length
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThan(2000)
  })

  it('prompts to add parameters when a dimension is empty', () => {
    const props = baseProps({
      parametersByDimension: {
        A: [param('pA1', 'A1', 0)],
        B: [],
        C: [param('pC1', 'C1', 0)],
      },
    })
    render(<CoverageMatrix {...props} />)
    expect(screen.getByText(/Add parameters to/)).toHaveTextContent('Bay')
  })
})
