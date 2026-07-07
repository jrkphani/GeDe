// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommandPalette } from './CommandPalette'
import { resetCommandRegistry, useCommandRegistryStore } from '../store/commandRegistry'
import { resetSemanticSearch, useSemanticSearchStore } from '../store/semanticSearch'
import type { CommandItem } from '../domain/paletteRanking'

afterEach(() => {
  resetCommandRegistry()
  resetSemanticSearch()
})

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

// Issue 042 — semantic search, tested at the palette's wiring boundary: never
// the real model (that lives behind `src/lib/semanticEmbedder.ts`, imported
// only from `src/store/semanticSearch.ts`'s `ensureModel`, which this file
// never calls) — always the store's own state, which is exactly what a
// stubbed embedder would eventually produce (test-first plan #1/#2).
describe('CommandPalette — semantic search (issue 042)', () => {
  it('is pure-lexical (byte-identical to issue 017) while the model is unloaded — the graceful-degradation contract', async () => {
    const user = userEvent.setup()
    register(
      verb('export', 'Export project…'),
      verb('rename', 'Rename project…'),
      verb('fade', 'Fade unconnected contexts'),
    )
    // The store is left in its default `idle` state (ensureModel was never
    // called — that's a shell-owned side effect, not the palette's).
    expect(useSemanticSearchStore.getState().status).toBe('idle')
    render(<CommandPalette open onClose={() => {}} />)

    // A query that only a *meaning* match (not a single shared letter run)
    // would surface must show nothing extra — pure lexical, no semantic
    // upgrade, exactly issue 017's behavior: none of the registered verbs
    // share a token with this query, so the palette falls through to the
    // empty state (which also proves "fade" — semantically the right
    // answer — is NOT surfaced without a loaded model).
    await user.keyboard('hide the unconnected')
    expect(await screen.findByText(/No matches/)).toBeInTheDocument()
    expect(screen.queryByText('Fade unconnected contexts')).not.toBeInTheDocument()
  })

  it('surfaces a semantically-relevant item that has no lexical match, once the store reports it', async () => {
    const user = userEvent.setup()
    register(
      verb('fade', 'Fade unconnected contexts'),
      verb('rename', 'Rename project…'),
    )
    const userQuery = 'hide the unconnected'
    // Simulate exactly what `scoreQuery` would have written after a real
    // (stubbed, per store-level tests) embed: a strong semantic hit for
    // "fade" against a query that shares no lexical tokens with its title.
    useSemanticSearchStore.setState({
      status: 'ready',
      query: userQuery,
      scores: new Map([
        ['fade', 0.92],
        ['rename', 0.02],
      ]),
    })
    render(<CommandPalette open onClose={() => {}} />)

    await user.keyboard(userQuery)
    expect(await screen.findByText('Fade unconnected contexts')).toBeInTheDocument()
    expect(screen.queryByText('Rename project…')).not.toBeInTheDocument()
  })
})
