// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppShell } from './AppShell'
import { useRoute } from './router'
import { ContextBar, ContextBarProvider } from './slots'
import { StatusBar } from './StatusBar'
import { useStatusStore } from '../store/status'

function TestShell({ filler }: { filler?: boolean }) {
  const route = useRoute()
  return (
    <ContextBarProvider>
      <AppShell route={route}>{filler === true ? <Filler /> : <div />}</AppShell>
    </ContextBarProvider>
  )
}

function Filler() {
  return (
    <ContextBar>
      <span>12 / 45 documented</span>
    </ContextBar>
  )
}

beforeEach(() => {
  window.history.replaceState(null, '', '/p/proj-1/foundation')
  useStatusStore.setState({ message: null, action: null })
})

describe('tier tabs', () => {
  it('renders all three tabs with the route-matching tab active', () => {
    render(<TestShell />)
    const foundation = screen.getByRole('link', { name: 'Foundation' })
    expect(foundation.className).toContain('tab--active')
    expect(foundation).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Architecture' }).className).not.toContain(
      'tab--active',
    )
    expect(screen.getByRole('link', { name: 'Design' }).className).not.toContain('tab--active')
  })

  it('clicking a tab navigates', async () => {
    const user = userEvent.setup()
    render(<TestShell />)
    await user.click(screen.getByRole('link', { name: 'Design' }))
    expect(window.location.pathname).toBe('/p/proj-1/design')
    expect(screen.getByRole('link', { name: 'Design' }).className).toContain('tab--active')
  })

  it('⌘1/⌘2/⌘3 switch tiers', async () => {
    const user = userEvent.setup()
    render(<TestShell />)
    await user.keyboard('{Meta>}3{/Meta}')
    expect(window.location.pathname).toBe('/p/proj-1/design')
    await user.keyboard('{Meta>}2{/Meta}')
    expect(window.location.pathname).toBe('/p/proj-1/architecture')
    await user.keyboard('{Meta>}1{/Meta}')
    expect(window.location.pathname).toBe('/p/proj-1/foundation')
  })
})

describe('context bar slot', () => {
  it('collapses entirely when no tier fills it', () => {
    const { container } = render(<TestShell />)
    expect(container.querySelector('.context-bar')).toHaveAttribute('hidden')
  })

  it('renders when a surface fills it', () => {
    const { container } = render(<TestShell filler />)
    expect(container.querySelector('.context-bar')).not.toHaveAttribute('hidden')
    expect(screen.getByText('12 / 45 documented')).toBeInTheDocument()
  })
})

describe('status bar', () => {
  it('announces narration through the polite live region with an inline action', async () => {
    const user = userEvent.setup()
    let ran = false
    useStatusStore.getState().announce('Archived “Tavalo”', {
      label: 'Undo',
      run: () => {
        ran = true
      },
    })
    render(<StatusBar />)
    const region = screen.getByRole('status')
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(region).toHaveTextContent('Archived “Tavalo”')
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    expect(ran).toBe(true)
    expect(region).not.toHaveTextContent('Archived')
  })
})
