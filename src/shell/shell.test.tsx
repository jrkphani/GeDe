// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppShell } from './AppShell'
import { navigate, useRoute } from './router'
import { ContextBar, ContextBarProvider } from './slots'
import { StatusBar } from './StatusBar'
import { useAuthStore, resetAuthStoreForTests } from '../store/auth'
import { useCommandLogStore } from '../store/commandLog'
import { useStatusStore } from '../store/status'

function pushFakeCommand(label: string) {
  const undo = vi.fn(async () => {})
  const redo = vi.fn(async () => {})
  useCommandLogStore.getState().push({ label, undo, redo })
  return { undo, redo }
}

function TestShell({ filler, lanes }: { filler?: boolean; lanes?: boolean }) {
  const route = useRoute()
  return (
    <ContextBarProvider>
      <AppShell route={route}>
        {lanes === true ? <Lanes /> : filler === true ? <Filler /> : <div />}
      </AppShell>
    </ContextBarProvider>
  )
}

// The three lane sections WorkspaceSurface renders in the real app (issue 089
// D2). AppShell doesn't own them, but ⌘1/2/3's scroll-to-lane queries them, so
// the ⌘ test mounts sentinel lanes to observe which one gets scrolled.
function Lanes() {
  return (
    <>
      <section className="workspace__lane workspace__lane--foundation" />
      <section className="workspace__lane workspace__lane--architecture" />
      <section className="workspace__lane workspace__lane--design" />
    </>
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
  useCommandLogStore.getState().clear()
  resetAuthStoreForTests()
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

  it('⌘1/⌘2/⌘3 switch tiers AND scroll the target lane into view (089 D2 P2)', async () => {
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    const user = userEvent.setup()
    const { container } = render(<TestShell lanes />)
    const laneEl = (lane: string) => container.querySelector(`.workspace__lane--${lane}`)

    // Still navigates the URL (retained routes / tab--active), and now also
    // brings the matching lane into view via scrollIntoView.
    await user.keyboard('{Meta>}3{/Meta}')
    expect(window.location.pathname).toBe('/p/proj-1/design')
    expect(scrollSpy.mock.instances.at(-1)).toBe(laneEl('design'))

    await user.keyboard('{Meta>}2{/Meta}')
    expect(window.location.pathname).toBe('/p/proj-1/architecture')
    expect(scrollSpy.mock.instances.at(-1)).toBe(laneEl('architecture'))

    await user.keyboard('{Meta>}1{/Meta}')
    expect(window.location.pathname).toBe('/p/proj-1/foundation')
    expect(scrollSpy.mock.instances.at(-1)).toBe(laneEl('foundation'))

    scrollSpy.mockRestore()
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

describe('undo/redo (issue 006)', () => {
  it('⌘Z undoes the top command and narrates it', async () => {
    const user = userEvent.setup()
    render(<TestShell />)
    // Pushed after mount — AppShell clears the log on mount too (harmless in
    // the real single-mount app; see the "clears on project switch" test).
    const { undo } = pushFakeCommand('rename α')
    await user.keyboard('{Meta>}z{/Meta}')
    expect(undo).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Undid: rename α')).toBeInTheDocument()
  })

  it('⇧⌘Z redoes the top future command and narrates it', async () => {
    const user = userEvent.setup()
    render(<TestShell />)
    const { redo } = pushFakeCommand('rename α')
    await useCommandLogStore.getState().undo()
    await user.keyboard('{Meta>}{Shift>}z{/Shift}{/Meta}')
    expect(redo).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Redid: rename α')).toBeInTheDocument()
  })

  it('does not fire while a text field with content is focused — native undo applies there', async () => {
    const user = userEvent.setup()
    render(<TestShell />)
    const { undo } = pushFakeCommand('rename α')
    const input = document.createElement('input')
    input.value = 'in-progress edit'
    document.body.appendChild(input)
    input.focus()
    await user.keyboard('{Meta>}z{/Meta}')
    expect(undo).not.toHaveBeenCalled()
    document.body.removeChild(input)
  })

  it('still fires when focus lands on an *empty* field — e.g. the phantom row right after a commit', async () => {
    const user = userEvent.setup()
    render(<TestShell />)
    const { undo } = pushFakeCommand('rename α')
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    await user.keyboard('{Meta>}z{/Meta}')
    expect(undo).toHaveBeenCalledTimes(1)
    document.body.removeChild(input)
  })

  it('the narration clears itself after a few seconds', async () => {
    const user = userEvent.setup()
    render(<TestShell />)
    pushFakeCommand('rename α')
    await user.keyboard('{Meta>}z{/Meta}')
    await screen.findByText('Undid: rename α')
    await waitFor(() => expect(screen.queryByText('Undid: rename α')).not.toBeInTheDocument(), {
      timeout: 3500,
    })
  })

  it('undo/redo buttons reflect stack state, disabled at empty with the fresh-session tooltip', async () => {
    render(<TestShell />)
    const undoButton = screen.getByRole('button', { name: 'Undo' })
    expect(undoButton).toBeDisabled()
    expect(undoButton).toHaveAttribute('title', 'Undo history starts fresh each session')

    pushFakeCommand('rename α')
    await waitFor(() => expect(undoButton).not.toBeDisabled())
    expect(undoButton).toHaveAttribute('title', 'Undo: rename α')
  })

  it('clears when the open project changes', async () => {
    render(<TestShell />)
    pushFakeCommand('rename α')
    expect(useCommandLogStore.getState().past).toHaveLength(1)
    navigate({ kind: 'tier', projectId: 'proj-2', tier: 'foundation' })
    await waitFor(() => expect(useCommandLogStore.getState().past).toEqual([]))
  })
})

describe('account affordance (issue 033, SITEMAP §2 "App bar (stable everywhere)")', () => {
  it('renders nothing when this build has no Cognito configuration (local-mode preserved)', () => {
    useAuthStore.setState({ configured: false, status: 'unauthenticated' })
    render(<TestShell />)
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument()
  })

  it('shows a quiet "Sign in" command button when configured but signed out', () => {
    useAuthStore.setState({ configured: true, status: 'unauthenticated', user: null })
    render(<TestShell />)
    const signIn = screen.getByRole('button', { name: 'Sign in' })
    expect(signIn.className).toContain('command-button')
  })

  it('clicking "Sign in" navigates to /login', async () => {
    const user = userEvent.setup()
    useAuthStore.setState({ configured: true, status: 'unauthenticated', user: null })
    render(<TestShell />)
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(window.location.pathname).toBe('/login')
  })

  it('shows the identity + a sign-out popover when authenticated', async () => {
    const user = userEvent.setup()
    useAuthStore.setState({
      configured: true,
      status: 'authenticated',
      user: { sub: 'user-1', email: 'me@example.com' },
    })
    render(<TestShell />)
    const trigger = screen.getByRole('button', { name: 'Account: me@example.com' })
    expect(trigger).toBeInTheDocument()
    await user.click(trigger)
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('sign-out clears the session', async () => {
    const user = userEvent.setup()
    useAuthStore.setState({
      configured: true,
      status: 'authenticated',
      user: { sub: 'user-1', email: 'me@example.com' },
    })
    render(<TestShell />)
    await user.click(screen.getByRole('button', { name: 'Account: me@example.com' }))
    await user.click(await screen.findByRole('button', { name: 'Sign out' }))
    expect(useAuthStore.getState().status).toBe('unauthenticated')
    expect(useAuthStore.getState().user).toBeNull()
  })

  // Issue 063 — the "redirect me away from the project on sign out" half of
  // the decided model: after teardown, sign-out lands on the hero/login page
  // (the canonical signed-out on-ramp, issue 064), not left sitting on
  // whatever project route was open.
  it('sign-out redirects to the hero/login page (issue 063 — shared-device safety)', async () => {
    const user = userEvent.setup()
    window.history.replaceState(null, '', '/p/proj-1/foundation')
    useAuthStore.setState({
      configured: true,
      status: 'authenticated',
      user: { sub: 'user-1', email: 'me@example.com' },
    })
    render(<TestShell />)
    await user.click(screen.getByRole('button', { name: 'Account: me@example.com' }))
    await user.click(await screen.findByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(window.location.pathname).toBe('/login'))
  })
})
