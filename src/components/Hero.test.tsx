// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Hero } from './Hero'

describe('Hero (issue 033 — the /welcome on-ramp)', () => {
  it('renders product framing plus both CTAs', () => {
    render(<Hero onSignIn={vi.fn()} onUseLocally={vi.fn()} />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/design generative systems/i)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use locally' })).toBeInTheDocument()
  })

  it('is keyboard-operable in shell focus order: Sign in before Use locally', async () => {
    const user = userEvent.setup()
    render(<Hero onSignIn={vi.fn()} onUseLocally={vi.fn()} />)
    await user.tab()
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Use locally' })).toHaveFocus()
  })

  it('Sign in and Use locally call their handlers, including via keyboard activation', async () => {
    const user = userEvent.setup()
    const onSignIn = vi.fn()
    const onUseLocally = vi.fn()
    render(<Hero onSignIn={onSignIn} onUseLocally={onUseLocally} />)

    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(onSignIn).toHaveBeenCalledTimes(1)

    screen.getByRole('button', { name: 'Use locally' }).focus()
    await user.keyboard('{Enter}')
    expect(onUseLocally).toHaveBeenCalledTimes(1)
  })
})
