// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { KeyHint } from './key-hint'

// Issue 084 Direction 3 P5 — a quiet, decorative keyboard-shortcut hint chip.
// The real shortcut is already announced by the labeled control it sits beside,
// so the hint is purely visual (aria-hidden) and adds ZERO screen-reader noise.

describe('KeyHint (084 D3 P5) — decorative shortcut chip', () => {
  it('renders each given key as its own <kbd> cap', () => {
    const { container } = render(<KeyHint keys={['⌘', '⏎']} />)
    const caps = container.querySelectorAll('kbd')
    expect(caps).toHaveLength(2)
    expect(caps[0]).toHaveTextContent('⌘')
    expect(caps[1]).toHaveTextContent('⏎')
  })

  it('renders a single-key hint (e.g. Tab / Esc)', () => {
    const { container } = render(<KeyHint keys={['Esc']} />)
    const caps = container.querySelectorAll('kbd')
    expect(caps).toHaveLength(1)
    expect(caps[0]).toHaveTextContent('Esc')
  })

  it('the root is aria-hidden — never in the accessibility tree', () => {
    const { container } = render(<KeyHint keys={['Tab', '→']} />)
    const root = container.firstElementChild as HTMLElement
    expect(root).toHaveAttribute('aria-hidden', 'true')
  })

  it('is token-compliant — no raw px in any inline style', () => {
    const { container } = render(<KeyHint keys={['⌘', '⏎']} />)
    for (const el of container.querySelectorAll('*')) {
      const style = el.getAttribute('style')
      if (style) expect(style).not.toMatch(/\d+px/)
    }
    // The root itself likewise carries no px inline style.
    const style = (container.firstElementChild as HTMLElement).getAttribute('style')
    if (style) expect(style).not.toMatch(/\d+px/)
  })

  it('accepts an extra className without dropping the base class', () => {
    const { container } = render(<KeyHint keys={['Esc']} className="extra" />)
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toMatch(/(?:^|\s)key-hint(?:\s|$)/)
    expect(root.className).toMatch(/(?:^|\s)extra(?:\s|$)/)
  })
})

describe('.key-hint CSS — token-only, quiet, muted (STYLE_GUIDE §6/§11)', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/base.css'), 'utf8')

  function ruleBody(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)
    if (!match) throw new Error(`No CSS rule found for ${selector}`)
    return match[1] as string
  }

  it('the cap is muted ink on a hairline border with the radius token', () => {
    const cap = ruleBody('.key-hint__cap')
    expect(cap).toMatch(/color:\s*var\(--ink-muted\)/)
    expect(cap).toMatch(/border:\s*1px solid var\(--hairline\)/)
    expect(cap).toMatch(/border-radius:\s*var\(--radius\)/)
  })

  it('the key-hint styling declares no raw px length (tokens only)', () => {
    // Only the ONE sanctioned 1px hairline border may carry a px literal; every
    // spacing/size value must be a token. Assert no OTHER px length appears in
    // the cap rule (padding/gap/font all token-driven).
    const cap = ruleBody('.key-hint__cap')
    const withoutHairline = cap.replace(/1px solid var\(--hairline\)/g, '')
    expect(withoutHairline).not.toMatch(/\d+px/)
  })

  it('phantom hints are hidden at rest and revealed on focus-within (quiet reveal)', () => {
    // Mirrors the established `.row-action` visibility:hidden → reveal pattern.
    // Both phantom surfaces (add-entry grid phantom, add-table row) share one
    // grouped rest rule and one grouped focus-within reveal rule.
    const rest = /\.grid-cell__phantom \.key-hint,\s*\.t2-add-table \.key-hint\s*\{([^}]*)\}/.exec(css)
    expect(rest?.[1]).toMatch(/visibility:\s*hidden/)
    const reveal =
      /\.grid-cell__phantom:focus-within \.key-hint,\s*\.t2-add-table:focus-within \.key-hint\s*\{([^}]*)\}/.exec(
        css,
      )
    expect(reveal?.[1]).toMatch(/visibility:\s*visible/)
  })
})
