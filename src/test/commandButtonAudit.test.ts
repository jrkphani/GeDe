import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Issue 026, test-first plan item 3: grep-guard so no always-visible
// standalone button silently regresses back onto the quiet `rowAction`/
// `.row-action` chrome (STYLE_GUIDE §6 — that class is for hover-revealed
// ROW affordances only: drag handle, add-child, per-row delete). Every
// caller below was audited in the issue and reassigned to `command`.
const STANDALONE_COMMAND_BUTTONS: readonly { file: string; label: string }[] = [
  { file: 'src/components/ArchitectureSurface.tsx', label: 'Use as dimension…' },
  { file: 'src/components/ArchitectureSurface.tsx', label: 'Promote' },
  { file: 'src/components/ArchitectureSurface.tsx', label: 'Keep parameter as unlinked copy' },
  { file: 'src/components/ProjectsList.tsx', label: 'Import project' },
  // Issue 082 Phase 1 — "Add dimension" (a command button) and "Dimensions"
  // (the popover trigger it lived behind) are both retired: the dimension
  // rail is now an always-open panel with a phantom-row "type to add a
  // dimension" input, the same grammar parameters/contexts already use — no
  // command button remains to audit. "Cancel" (RemoveDimensionConfirm) is
  // unaffected and stays below.
  { file: 'src/components/DimensionManager.tsx', label: 'Cancel' },
  // Issue 064 (evolving issue 033): the hero/landing page's per-mode submit
  // is each a standalone, always-visible action — never a row affordance.
  { file: 'src/components/HeroLanding.tsx', label: 'Sign in' },
  { file: 'src/components/HeroLanding.tsx', label: 'Sign up' },
  { file: 'src/components/HeroLanding.tsx', label: 'Verify' },
  // Issue 033: the not-found panel's own recovery action (HANDOFF flagged
  // this exact button as a latent 026 candidate before it was migrated off
  // a raw <button className="row-action">).
  { file: 'src/App.tsx', label: 'Back to projects' },
]

// Finds the JSX child text ">Label" (i.e. Label rendered directly as a
// Button's children, not inside an attribute like aria-label={`Label ...`}),
// then walks back to that Button's own opening tag. Slicing on `>` index
// boundaries (rather than a `[^>]*` capture group) is deliberate — several of
// these buttons carry `onClick={() => …}` handlers whose arrow `=>` contains
// a `>` character that would otherwise truncate a naive prop capture early.
function openingTagProps(source: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const childMatch = new RegExp(`>\\s*${escaped}`, 'm').exec(source)
  if (childMatch?.index === undefined) {
    throw new Error(`No JSX child text ">${label}" was found`)
  }
  const closingBracketIndex = childMatch.index
  const tagStart = source.lastIndexOf('<Button', closingBracketIndex)
  if (tagStart === -1) {
    throw new Error(`No enclosing <Button for: ${label}`)
  }
  return source.slice(tagStart, closingBracketIndex + 1)
}

describe('command-button audit (issue 026 test-first plan item 3)', () => {
  it.each(STANDALONE_COMMAND_BUTTONS)(
    'the "$label" button in $file is the command variant, not rowAction/row-action',
    ({ file, label }) => {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8')
      const props = openingTagProps(source, label)
      expect(props).toMatch(/variant=["']command["']/)
      expect(props).not.toMatch(/variant=["']rowAction["']/)
      expect(props).not.toMatch(/className=["']row-action["']/)
    },
  )
})

describe('row-hover actions remain quiet (issue 026 test-first plan item 4 — regression)', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/base.css'), 'utf8')

  it('table row actions (.t2-meta .row-action) stay visibility: hidden at rest', () => {
    const match = /\.t2-meta \.row-action\s*\{([^}]*)\}/.exec(css)
    expect(match).not.toBeNull()
    expect((match as RegExpMatchArray)[1]).toMatch(/visibility:\s*hidden/)
    expect(css).toContain('.t2-table tbody tr:hover .t2-meta .row-action,')
  })

  it('project row actions (.project-row .row-action) stay visibility: hidden at rest', () => {
    expect(css).toContain('.project-row .row-action {\n  visibility: hidden;\n}')
    expect(css).toContain('.project-row:hover .row-action,')
  })

  it('dimension row actions (.dim-row .row-action) stay visibility: hidden at rest', () => {
    expect(css).toMatch(/\.dim-row \.row-action,\s*\n\.dim-row \.drag-handle\s*\{\s*\n\s*visibility:\s*hidden;/)
    expect(css).toContain('.dim-row:hover .row-action,')
  })
})
