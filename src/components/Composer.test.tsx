// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Composer } from './Composer'
import type { ContextRow, DimensionRow } from '../db/mutations'

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
})
