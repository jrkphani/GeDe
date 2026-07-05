// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommandPalette } from './CommandPalette'
import { resetCommandRegistry, useCommandRegistryStore } from '../store/commandRegistry'
import type { CommandItem } from '../domain/paletteRanking'

afterEach(() => resetCommandRegistry())

function register(...items: CommandItem[]): void {
  for (const item of items) useCommandRegistryStore.getState().registerCommand(item)
}

const verb = (id: string, title: string, run = () => {}): CommandItem => ({
  id,
  kind: 'action',
  title,
  run,
})

describe('CommandPalette', () => {
  it('surfaces a feature-registered verb with no palette code changes', async () => {
    const user = userEvent.setup()
    register(verb('export', 'Export project…'), verb('import', 'Import project…'))
    render(<CommandPalette open onClose={() => {}} />)

    await user.keyboard('export')
    expect(await screen.findByText('Export project…')).toBeInTheDocument()
    expect(screen.queryByText('Import project…')).not.toBeInTheDocument()
  })

  it('exposes the combobox pattern and is operable with arrows + Enter', async () => {
    const first = vi.fn()
    const second = vi.fn()
    register(verb('a', 'Alpha action', first), verb('b', 'Alpha backup', second))
    const user = userEvent.setup()
    render(<CommandPalette open onClose={() => {}} />)

    // Combobox pattern: an input with role combobox and an announced listbox of
    // options (aria-activedescendant is verified in the browser — cmdk's active
    // marker is `aria-selected` on the option, which is what moves here).
    expect(screen.getByRole('combobox')).toBeInTheDocument()
    await user.keyboard('alpha')
    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(2)
    expect(screen.getByRole('listbox')).toBeInTheDocument()

    await waitFor(() => expect(options[0]).toHaveAttribute('aria-selected', 'true'))
    await user.keyboard('{ArrowDown}')
    await waitFor(() => expect(options[1]).toHaveAttribute('aria-selected', 'true'))
    expect(options[0]).toHaveAttribute('aria-selected', 'false')

    await user.keyboard('{Enter}')
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('closes and returns focus to the origin element on Escape', async () => {
    // Mirrors AppShell's contract: capture the focused origin when opening, and
    // restore it on a dismissal (navigated === false).
    function Harness() {
      const [open, setOpen] = useState(false)
      const originRef = useRef<HTMLElement | null>(null)
      return (
        <>
          <button
            type="button"
            onClick={() => {
              originRef.current = document.activeElement as HTMLElement
              setOpen(true)
            }}
          >
            origin
          </button>
          <CommandPalette
            open={open}
            onClose={(navigated) => {
              setOpen(false)
              if (!navigated) {
                const origin = originRef.current
                requestAnimationFrame(() => origin?.focus())
              }
            }}
          />
        </>
      )
    }
    const user = userEvent.setup()
    render(<Harness />)
    const origin = screen.getByRole('button', { name: 'origin' })
    await user.click(origin)

    const input = await screen.findByPlaceholderText(/Jump to a tier/)
    await waitFor(() => expect(input).toHaveFocus())

    await user.keyboard('{Escape}')
    await waitFor(() => expect(origin).toHaveFocus())
  })

  it('shows the create-context hint only when the query could be a name', async () => {
    const user = userEvent.setup()
    register(verb('export', 'Export project…'))
    render(<CommandPalette open onClose={() => {}} />)

    await user.keyboard('Payments')
    expect(await screen.findByText(/Enter creates a context named/)).toBeInTheDocument()
    expect(screen.getByText(/Payments/)).toBeInTheDocument()
  })
})
