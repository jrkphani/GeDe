// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Button, buttonVariants } from './button'

// Issue 026 — standalone "command" buttons (Export…/Import…, Use as
// dimension…) need a resting affordance distinct from `.row-action`'s
// hover-revealed, quiet row chrome (STYLE_GUIDE §6). Test-first plan items 1-2.

describe('Button — command variant (issue 026)', () => {
  it('renders a distinct class from rowAction — no shared quiet-row-action chrome', () => {
    render(<Button variant="command">Import project</Button>)
    const button = screen.getByRole('button', { name: 'Import project' })
    expect(button.className).not.toMatch(/(?:^|\s)row-action(?:\s|$)/)
    expect(button.className).toMatch(/(?:^|\s)command-button(?:\s|$)/)
  })

  it('cva variant map keeps rowAction and command as separate classes', () => {
    const rowAction = buttonVariants({ variant: 'rowAction' })
    const command = buttonVariants({ variant: 'command' })
    expect(rowAction).toContain('row-action')
    expect(command).toContain('command-button')
    expect(command).not.toContain('row-action')
  })
})

describe('.command-button CSS — resting affordance + contrast (STYLE_GUIDE §10)', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/base.css'), 'utf8')

  function ruleBody(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)
    if (!match) throw new Error(`No CSS rule found for ${selector}`)
    return match[1] as string
  }

  it('has a non-transparent resting fill and --ink text (not --ink-muted, unlike row-action)', () => {
    const resting = ruleBody('.command-button')
    expect(resting).toMatch(/background:\s*var\(--paper\)/)
    expect(resting).toMatch(/color:\s*var\(--ink\)/)
    expect(resting).not.toMatch(/color:\s*var\(--ink-muted\)/)
    expect(resting).toMatch(/border:\s*1px solid var\(--ink-muted\)/)
  })

  it('deepens the fill on hover rather than introducing contrast for the first time', () => {
    const hover = ruleBody('.command-button:hover')
    expect(hover).toMatch(/background:\s*var\(--grid-minor\)/)
  })

  it('does not touch .row-action visibility:hidden (row-hover progressive disclosure, unchanged)', () => {
    expect(css).toMatch(/\.row-action\s*\{[^}]*}/)
    // The row-hover reveal rules must still exist verbatim. (Issue 084 moved
    // the tier-2 row verb to the trailing .t2-col--actions gutter; issue 105 P5
    // made that verb the ⋯ row-action menu trigger — the reveal pattern is
    // unchanged, only the class was renamed .t2-add-child-trigger → .t2-row-menu-trigger.)
    expect(css).toContain('.t2-table tbody tr:hover .t2-col--actions .t2-row-menu-trigger,')
    expect(css).toContain('.project-row:hover .row-action,')
    expect(css).toContain('.dim-row:hover .row-action,')
  })

  // Token-driven WCAG contrast check, both themes (STYLE_GUIDE §10: text ≥4.5:1,
  // UI glyph boundary ≥3:1). Reads the live token values so this stays honest
  // if tokens.css ever changes, rather than hardcoding hex twice.
  const tokensCss = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8')

  function tokenValue(theme: 'light' | 'dark', name: string): string {
    const block =
      theme === 'light'
        ? /:root\s*\{([^}]*)\}/.exec(tokensCss)?.[1]
        : /\[data-theme=['"]dark['"]\]\s*\{([^}]*)\}/.exec(tokensCss)?.[1]
    if (!block) throw new Error(`No token block for theme ${theme}`)
    const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(block)
    if (!m) throw new Error(`No token --${name} in theme ${theme}`)
    return (m[1] as string).trim()
  }

  function hexToRgb(hex: string): [number, number, number] {
    const h = hex.replace('#', '')
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  }

  function relativeLuminance([r, g, b]: [number, number, number]): number {
    const [rs, gs, bs] = [r, g, b].map((c) => {
      const cs = c / 255
      return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4)
    })
    return 0.2126 * (rs as number) + 0.7152 * (gs as number) + 0.0722 * (bs as number)
  }

  function contrastRatio(hexA: string, hexB: string): number {
    const lA = relativeLuminance(hexToRgb(hexA))
    const lB = relativeLuminance(hexToRgb(hexB))
    const [lighter, darker] = lA > lB ? [lA, lB] : [lB, lA]
    return (lighter + 0.05) / (darker + 0.05)
  }

  it.each(['light', 'dark'] as const)('meets §10 contrast thresholds at rest in the %s theme', (theme) => {
    const paper = tokenValue(theme, 'paper')
    const ink = tokenValue(theme, 'ink')
    const inkMuted = tokenValue(theme, 'ink-muted')

    // Text ≥ 4.5:1 against the command button's fill.
    expect(contrastRatio(ink, paper)).toBeGreaterThanOrEqual(4.5)
    // UI boundary (the firmer border) ≥ 3:1 against the fill.
    expect(contrastRatio(inkMuted, paper)).toBeGreaterThanOrEqual(3)
  })
})
