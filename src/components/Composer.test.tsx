// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Composer } from './Composer'
import type { ContextRow, DimensionRow, ParameterRow } from '../db/mutations'

function param(dimensionId: string, id: string, name: string, sort: number): ParameterRow {
  return {
    id,
    dimensionId,
    parentParamId: null,
    sourceEntryId: null,
    name,
    sort,
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
  }
}

function dim(id: string, sort: number, name: string, color = '#6f5bd6'): DimensionRow {
  return {
    id,
    projectId: 'proj1',
    contextId: null,
    name,
    color,
    sort,
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
  }
}

function ctx(id: string, symbol: string, justification: string | null): ContextRow {
  return {
    id,
    projectId: 'proj1',
    parentId: null,
    symbol,
    name: null,
    justification,
    sort: 0,
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
  }
}

const dimensions = [dim('d0', 0, 'Value'), dim('d1', 1, 'Stake')]
const paramNameById = { p0: 'Comfort', p1: 'Users' }

describe('Composer', () => {
  it('renders nothing when nothing is selected', () => {
    const { container } = render(
      <Composer
        dimensions={dimensions}
        selected={null}
        bindings={{}}
        paramNameById={paramNameById}
        onJustificationCommit={() => {}}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a per-dimension legend with the bound parameter name, or a placeholder when unbound', () => {
    render(
      <Composer
        dimensions={dimensions}
        selected={ctx('ctxA', 'α', null)}
        bindings={{ d0: 'p0' }} // d1 unbound
        paramNameById={paramNameById}
        onJustificationCommit={() => {}}
      />,
    )
    expect(screen.getByText('Value')).toBeInTheDocument()
    expect(screen.getByText('Comfort')).toBeInTheDocument()
    expect(screen.getByText('Stake')).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('renders the mono tuple readout in dimension order, with placeholders for unbound dimensions', () => {
    render(
      <Composer
        dimensions={dimensions}
        selected={ctx('ctxA', 'α', null)}
        bindings={{ d0: 'p0' }}
        paramNameById={paramNameById}
        onJustificationCommit={() => {}}
      />,
    )
    expect(screen.getByText('{Comfort} {—}')).toBeInTheDocument()
  })

  it('shows the existing justification text and commits an edit', async () => {
    const user = userEvent.setup()
    const onJustificationCommit = vi.fn()
    render(
      <Composer
        dimensions={dimensions}
        selected={ctx('ctxA', 'α', 'Original reason')}
        bindings={{ d0: 'p0', d1: 'p1' }}
        paramNameById={paramNameById}
        onJustificationCommit={onJustificationCommit}
      />,
    )
    await user.click(screen.getByText('Original reason'))
    await user.clear(screen.getByRole('textbox'))
    await user.type(screen.getByRole('textbox'), 'New reason')
    await user.keyboard('{Enter}')
    expect(onJustificationCommit).toHaveBeenCalledExactlyOnceWith('New reason')
  })

  describe('compose/edit mode (issue 010)', () => {
    const composeParams = {
      d0: [param('d0', 'p0', 'Comfort', 0), param('d0', 'p1', 'Ease', 1)],
      d1: [param('d1', 'p2', 'Users', 0)],
    }

    function renderCompose(
      overrides: Partial<Parameters<typeof Composer>[0]> = {},
    ) {
      const props = {
        dimensions,
        selected: ctx('ctxA', 'α', null),
        bindings: {} as Record<string, string>,
        paramNameById,
        onJustificationCommit: () => {},
        composing: true,
        activeDimensionId: 'd0' as string | null,
        parametersByDimension: composeParams,
        onBindParameter: () => {},
        onUnbindParameter: () => {},
        duplicateSiblingSymbols: [] as readonly string[],
        ...overrides,
      }
      return render(<Composer {...props} />)
    }

    it('renders one parameter picker per dimension in sort order', () => {
      const { container } = renderCompose()
      expect(container.querySelectorAll('.composer-picker')).toHaveLength(2)
    })

    it('marks the active dimension picker', () => {
      const { container } = renderCompose({ activeDimensionId: 'd1' })
      const pickers = container.querySelectorAll('.composer-picker')
      expect(pickers[0]).not.toHaveClass('composer-picker--active')
      expect(pickers[1]).toHaveClass('composer-picker--active')
    })

    it('selecting a parameter from a picker binds that dimension', async () => {
      const user = userEvent.setup()
      const onBindParameter = vi.fn()
      const { container } = renderCompose({ onBindParameter })
      await user.click(container.querySelectorAll('.composer-picker')[0] as HTMLElement)
      await user.click(screen.getByText('Comfort'))
      expect(onBindParameter).toHaveBeenCalledExactlyOnceWith('d0', 'p0')
    })

    it('clearing a bound picker unbinds that dimension', async () => {
      const user = userEvent.setup()
      const onUnbindParameter = vi.fn()
      const { container } = renderCompose({ bindings: { d0: 'p0' }, onUnbindParameter })
      await user.click(container.querySelectorAll('.composer-picker')[0] as HTMLElement)
      await user.click(screen.getByText('— clear —'))
      expect(onUnbindParameter).toHaveBeenCalledExactlyOnceWith('d0')
    })

    it('shows a live duplicate badge only when the pending tuple matches an existing context', () => {
      const { container, rerender } = renderCompose({ duplicateSiblingSymbols: [] })
      expect(container.querySelector('.composer-duplicate')).toBeNull()
      rerender(
        <Composer
          dimensions={dimensions}
          selected={ctx('ctxA', 'α', null)}
          bindings={{ d0: 'p0', d1: 'p2' }}
          paramNameById={paramNameById}
          onJustificationCommit={() => {}}
          composing
          activeDimensionId={null}
          parametersByDimension={composeParams}
          onBindParameter={() => {}}
          onUnbindParameter={() => {}}
          duplicateSiblingSymbols={['β']}
        />,
      )
      expect(container.querySelector('.composer-duplicate')).toHaveTextContent('β')
    })

    it('read mode renders no pickers', () => {
      const { container } = render(
        <Composer
          dimensions={dimensions}
          selected={ctx('ctxA', 'α', null)}
          bindings={{ d0: 'p0' }}
          paramNameById={paramNameById}
          onJustificationCommit={() => {}}
        />,
      )
      expect(container.querySelectorAll('.composer-picker')).toHaveLength(0)
    })
  })
})
