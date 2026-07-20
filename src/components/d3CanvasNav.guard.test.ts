import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

// ── 089-D3 prod-bundle guard (P7: RF now SHIPS — keep it in its own chunk) ────
// GRADUATED at P7: the canvas is the default workspace, so `@xyflow/react` (JS +
// its ~18.6 KB stylesheet, ~88 KB gz all-in) now legitimately SHIPS to prod. But
// it must stay in WorkspaceCanvas's OWN `React.lazy` async chunk, NEVER the main
// bundle — because the capability gate renders WorkspaceSurface (not the canvas)
// on narrow (< 1024px) / reduced-data clients, and those clients must NOT pay to
// download React Flow to boot. WorkspaceCanvas is the sole importer of React Flow
// and `@xyflow/react/dist/style.css`; a single STATIC `import … from
// '.../WorkspaceCanvas'` anywhere would pull RF's JS into the main bundle, and —
// because Vite/Rollup NEVER tree-shake a side-effect CSS import — its CSS would
// re-enter every client's boot payload. So the invariant is no longer "RF is
// excluded" but "RF is BUDGETED to its lazy chunk, off the main-bundle critical
// path."
//
// Rather than run the multi-minute production build in the fast unit suite, this
// asserts the STRUCTURAL invariant that holds the budget: WorkspaceCanvas is
// imported only dynamically. It's fast, deterministic, and never flaky. The
// end-to-end size proof (grep `dist/assets/*.js` — RF must appear ONLY in a
// `WorkspaceCanvas-*` chunk, never the entry/index chunk; ceiling ~88 KB gz)
// stays a manual / pre-release check.

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full))
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

// A STATIC import/re-export of a module path: `import x from '<path>'`,
// `import '<path>'`, or `export … from '<path>'`. Deliberately excludes dynamic
// `import('<path>')` (that form has a `(` before the quote, no `from`).
function staticImportSpecifiers(source: string): string[] {
  const specs: string[] = []
  const fromRe = /(?:^|\n)\s*(?:import|export)\b[^\n(;]*?from\s*['"]([^'"]+)['"]/g
  const bareRe = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
  for (const re of [fromRe, bareRe]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(source)) !== null) specs.push(m[1] as string)
  }
  return specs
}

function dynamicImportSpecifiers(source: string): string[] {
  const specs: string[] = []
  const re = /import\(\s*['"]([^'"]+)['"]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) specs.push(m[1] as string)
  return specs
}

const isWorkspaceCanvas = (spec: string) => spec.endsWith('/WorkspaceCanvas')

describe('089-D3 prod-bundle guard: React Flow stays out of the main bundle', () => {
  const files = sourceFiles(SRC_DIR)

  it('no source file STATICALLY imports WorkspaceCanvas (only dynamic import() is allowed)', () => {
    const offenders = files.filter((file) =>
      staticImportSpecifiers(readFileSync(file, 'utf8')).some(isWorkspaceCanvas),
    )
    expect(
      offenders,
      'A static import of WorkspaceCanvas drags @xyflow/react JS + its CSS back into the prod bundle. Use a dynamic import() (React.lazy) instead.',
    ).toEqual([])
  })

  it('WorkspaceCanvas is reached via a dynamic import() somewhere (the lazy mount site)', () => {
    const hasDynamic = files.some((file) =>
      dynamicImportSpecifiers(readFileSync(file, 'utf8')).some(isWorkspaceCanvas),
    )
    expect(hasDynamic).toBe(true)
  })

  it('the eager nav module (d3CanvasNav) imports NO @xyflow/react (so importing it eagerly costs prod nothing)', () => {
    const nav = readFileSync(join(SRC_DIR, 'components', 'd3CanvasNav.ts'), 'utf8')
    const specs = [...staticImportSpecifiers(nav), ...dynamicImportSpecifiers(nav)]
    const xyflow = specs.filter((s) => s.startsWith('@xyflow/'))
    expect(xyflow, 'd3CanvasNav must stay React-Flow-free — it is imported eagerly by App.tsx').toEqual([])
  })

  it('App.tsx eagerly imports the nav module (register-first ⌘1/2/3 ordering, before AppShell)', () => {
    const app = readFileSync(join(SRC_DIR, 'App.tsx'), 'utf8')
    expect(staticImportSpecifiers(app)).toContain('./components/d3CanvasNav')
  })
})
