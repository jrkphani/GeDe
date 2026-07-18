// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  chainOrder,
  firstEditableCell,
  lastEditablePosition,
  resolveExitTarget,
} from './gridBoundaryFocus'

// ── chainOrder (084 D3): the flattened cross-table chain vocabulary. Each table
// contributes an `:in` (first editable cell) then an `:out` (add-entry phantom),
// and the whole column ends with the single trailing add-table phantom. ───────
describe('chainOrder', () => {
  it('flattens tables to :in/:out pairs then the trailing t2phantom', () => {
    expect(chainOrder([{ id: 'a' }, { id: 'b' }])).toEqual([
      't2tbl:a:in',
      't2tbl:a:out',
      't2tbl:b:in',
      't2tbl:b:out',
      't2phantom',
    ])
  })

  it('is just the add-table phantom when there are no tables', () => {
    expect(chainOrder([])).toEqual(['t2phantom'])
  })
})

// ── resolveExitTarget (084 D3): pure neighbor resolution over the chain, with no
// DOM. Forward from a table's `:out` lands on the next table's `:in` (or the
// trailing phantom for the last table); backward from a table's `:in` lands on
// the previous table's `:out`; the first table's `:in` is the true start edge. ─
describe('resolveExitTarget', () => {
  const tables = [{ id: 'a' }, { id: 'b' }]

  it('forward from a table :out → next table :in', () => {
    expect(resolveExitTarget('t2tbl:a:out', 'forward', tables)).toBe('t2tbl:b:in')
  })

  it('forward from the last table :out → the trailing t2phantom', () => {
    expect(resolveExitTarget('t2tbl:b:out', 'forward', tables)).toBe('t2phantom')
  })

  it('backward from a table :in → previous table :out', () => {
    expect(resolveExitTarget('t2tbl:b:in', 'backward', tables)).toBe('t2tbl:a:out')
  })

  it('backward from the first table :in → null (true start edge)', () => {
    expect(resolveExitTarget('t2tbl:a:in', 'backward', tables)).toBeNull()
  })
})

// ── DOM focus helpers: extracted verbatim from WorkspaceCanvas. `firstEditableCell`
// picks the first editable grid cell (or the phantom input when the table is
// empty); `lastEditablePosition` picks the phantom input (visually + tab-order
// last), falling back to the last editable grid cell when there is no phantom. ─
function tableSection(html: string): HTMLElement {
  const section = document.createElement('div')
  section.className = 'react-flow__node'
  section.innerHTML = html
  return section
}

describe('firstEditableCell', () => {
  it('picks the first editable grid cell', () => {
    const section = tableSection(`
      <table class="editable-grid"><tbody>
        <tr data-row-id="r1"><td><div class="grid-cell" tabindex="0" id="c1">one</div></td></tr>
        <tr data-row-id="r2"><td><div class="grid-cell" tabindex="0" id="c2">two</div></td></tr>
        <tr class="grid-row--phantom"><td><input id="phantom" /></td></tr>
      </tbody></table>
    `)
    expect(firstEditableCell(section)?.id).toBe('c1')
  })

  it('falls back to the phantom input for an empty table', () => {
    const section = tableSection(`
      <table class="editable-grid"><tbody>
        <tr class="grid-row--phantom"><td><input id="phantom" /></td></tr>
      </tbody></table>
    `)
    expect(firstEditableCell(section)?.id).toBe('phantom')
  })

  it('returns null when there is no editable position at all', () => {
    const section = tableSection(`<table class="editable-grid"><tbody></tbody></table>`)
    expect(firstEditableCell(section)).toBeNull()
  })
})

describe('lastEditablePosition', () => {
  it('picks the phantom input (tab-order last)', () => {
    const section = tableSection(`
      <table class="editable-grid"><tbody>
        <tr data-row-id="r1"><td><div class="grid-cell" tabindex="0" id="c1">one</div></td></tr>
        <tr data-row-id="r2"><td><div class="grid-cell" tabindex="0" id="c2">two</div></td></tr>
        <tr class="grid-row--phantom"><td><input id="phantom" /></td></tr>
      </tbody></table>
    `)
    expect(lastEditablePosition(section)?.id).toBe('phantom')
  })

  it('falls back to the last editable grid cell when there is no phantom', () => {
    const section = tableSection(`
      <table class="editable-grid"><tbody>
        <tr data-row-id="r1"><td><div class="grid-cell" tabindex="0" id="c1">one</div></td></tr>
        <tr data-row-id="r2"><td><div class="grid-cell" tabindex="0" id="c2">two</div></td></tr>
      </tbody></table>
    `)
    expect(lastEditablePosition(section)?.id).toBe('c2')
  })

  it('returns null when there is no editable position at all', () => {
    const section = tableSection(`<table class="editable-grid"><tbody></tbody></table>`)
    expect(lastEditablePosition(section)).toBeNull()
  })
})
