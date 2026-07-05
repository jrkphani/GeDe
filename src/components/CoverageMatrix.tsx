import { useEffect, useMemo, useRef, useState } from 'react'
import type { ContextRow, DimensionRow, ParameterRow } from '../db/mutations'
import { tupleReadout } from '../domain/contextDescription'
import {
  assignmentTupleHash,
  coverageStat,
  defaultAxes,
  documentedTuples,
  filterDimensionIds,
  type AxisChoice,
} from '../domain/coverage'
import { windowRange } from '../domain/gridWindow'
import { Button } from './ui/button'
import { Combobox } from './ui/combobox'
import { Swatch } from './ui/swatch'

// Coverage matrix (issue 012, SPEC §4.5). The whole tuple space of the current
// canvas as plotted graph paper: 24px cells on the grid pitch (STYLE_GUIDE
// §2.1), documented = mono symbol on ink fill, unexplored = hairline hollow
// square. Shape + fill carry state (colorblind-safe); dimension colors show
// only in the axis-picker swatches. It reuses the register/canvas keyboard
// grammar (roving tabindex, arrows/Home/End) rather than inventing a new one,
// and virtualizes both axes (windowRange) so ∏ mᵢ ≈ 10⁴ stays jank-free.

const CELL = 24 // graph-paper pitch
const ROW_HEADER_W = 132
const COL_HEADER_H = 96
const VIEWPORT_MAX_H = 480

export interface CoverageMatrixProps {
  dimensions: DimensionRow[]
  parametersByDimension: Record<string, ParameterRow[]>
  contexts: ContextRow[]
  bindingsByContext: Record<string, Record<string, string>>
  selectedContextId: string | null
  // Documented cell activated — select that context (stacked symbols cycle on
  // repeated activation, so the caller receives each context id in turn).
  onSelectContext: (id: string) => void
  // Hollow cell activated — enter compose pre-filled with this full tuple
  // (SPEC §4.5 "gap → pre-filled composer"; issue 010 handoff).
  onComposeTuple: (bindings: Record<string, string>) => void
}

interface FocusCell {
  r: number
  c: number
}

export function CoverageMatrix({
  dimensions,
  parametersByDimension,
  contexts,
  bindingsByContext,
  selectedContextId,
  onSelectContext,
  onComposeTuple,
}: CoverageMatrixProps) {
  const orderedDimensions = useMemo(
    () => [...dimensions].sort((a, b) => a.sort - b.sort),
    [dimensions],
  )
  const orderedDimensionIds = useMemo(() => orderedDimensions.map((d) => d.id), [orderedDimensions])
  const dimSignature = orderedDimensionIds.join('|')

  const paramIdsByDimension = useMemo(() => {
    const map: Record<string, string[]> = {}
    for (const d of orderedDimensions) map[d.id] = (parametersByDimension[d.id] ?? []).map((p) => p.id)
    return map
  }, [orderedDimensions, parametersByDimension])

  const paramNameById = useMemo(() => {
    const map: Record<string, string> = {}
    for (const list of Object.values(parametersByDimension)) for (const p of list) map[p.id] = p.name
    return map
  }, [parametersByDimension])

  const dimById = useMemo(() => new Map(orderedDimensions.map((d) => [d.id, d])), [orderedDimensions])

  const coverageContexts = useMemo(
    () =>
      contexts.map((c) => ({
        id: c.id,
        symbol: c.symbol,
        bindings: bindingsByContext[c.id] ?? {},
        justification: c.justification,
      })),
    [contexts, bindingsByContext],
  )

  const docMap = useMemo(
    () => documentedTuples(orderedDimensionIds, coverageContexts),
    [orderedDimensionIds, coverageContexts],
  )
  const stat = useMemo(
    () => coverageStat(orderedDimensionIds, paramIdsByDimension, coverageContexts),
    [orderedDimensionIds, paramIdsByDimension, coverageContexts],
  )

  // Axes: two-largest default (SPEC §4.5), repaired if a chosen dimension is
  // removed. Swapping preserves filters because filter selections are keyed by
  // dimension id, independent of which two dimensions are on the grid.
  const [axes, setAxes] = useState<AxisChoice | null>(null)
  useEffect(() => {
    setAxes((prev) => {
      if (
        prev &&
        orderedDimensionIds.includes(prev.rowDimId) &&
        orderedDimensionIds.includes(prev.colDimId) &&
        prev.rowDimId !== prev.colDimId
      ) {
        return prev
      }
      return defaultAxes(orderedDimensionIds, paramIdsByDimension)
    })
    // Keyed on the dimension set, not the params array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimSignature])

  const [filters, setFilters] = useState<Record<string, string>>({})
  const [focus, setFocus] = useState<FocusCell>({ r: 0, c: 0 })
  const [scroll, setScroll] = useState({ top: 0, left: 0 })
  const [viewport, setViewport] = useState({ w: 640, h: VIEWPORT_MAX_H })
  const [hoverTuple, setHoverTuple] = useState<string | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const cellRefs = useRef<Map<string, HTMLButtonElement>>(new Map())
  const cycleRef = useRef<Map<string, number>>(new Map())
  const jumpBuffer = useRef<{ text: string; at: number }>({ text: '', at: 0 })
  const focusPending = useRef(false)

  // Measure the scroll viewport for windowing (ResizeObserver is a no-op in
  // jsdom, so tests keep the generous default and render small grids whole).
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      setViewport({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Focus + scroll the roving tab stop into view after a keyboard move only —
  // never steal focus on mount or on a data change. Declared before any early
  // return so the hook order stays stable across degenerate states.
  useEffect(() => {
    if (!focusPending.current) return
    focusPending.current = false
    const el = cellRefs.current.get(`${focus.r}:${focus.c}`)
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    el?.focus()
  }, [focus])

  // Degenerate: below the floor (never reached — guided upstream) or a chosen
  // axis is gone before the repair effect runs.
  if (orderedDimensionIds.length < 2 || !axes) {
    return (
      <section className="panel coverage-matrix">
        <p className="placeholder">Add at least two dimensions to plot coverage.</p>
      </section>
    )
  }

  const { rowDimId, colDimId } = axes
  const rowDim = dimById.get(rowDimId)
  const colDim = dimById.get(colDimId)
  const rowParams = parametersByDimension[rowDimId] ?? []
  const colParams = parametersByDimension[colDimId] ?? []
  const filterDims = filterDimensionIds(orderedDimensionIds, axes)

  // Degenerate: a dimension with no parameters can't be plotted (∏ mᵢ = 0).
  const emptyDim = orderedDimensions.find((d) => (paramIdsByDimension[d.id]?.length ?? 0) === 0)
  if (emptyDim) {
    return (
      <section className="panel coverage-matrix">
        <p className="placeholder">
          Add parameters to <span className="font-mono">{emptyDim.name}</span> to plot coverage.
        </p>
      </section>
    )
  }

  // Effective filter selection: the chosen page parameter per filter dimension,
  // defaulting to its first parameter until the user pages.
  const effectiveFilters: Record<string, string> = {}
  for (const dimId of filterDims) {
    const list = paramIdsByDimension[dimId] ?? []
    const chosen = filters[dimId]
    effectiveFilters[dimId] = chosen && list.includes(chosen) ? chosen : (list[0] as string)
  }

  const rowCount = rowParams.length
  const colCount = colParams.length

  function assignmentFor(r: number, c: number): Record<string, string> {
    return {
      ...effectiveFilters,
      [rowDimId]: rowParams[r]?.id as string,
      [colDimId]: colParams[c]?.id as string,
    }
  }
  function cellTuple(r: number, c: number) {
    return tupleReadout(orderedDimensions, assignmentFor(r, c), paramNameById).join(' · ')
  }

  // Windowing on both axes, widened to always include the focused cell so the
  // roving tab stop is mounted (keyboard focus never lands on a culled node).
  const viewH = Math.min(rowCount * CELL, viewport.h - COL_HEADER_H, VIEWPORT_MAX_H)
  const rowWin = windowRange(scroll.top, viewH, CELL, rowCount)
  const colWin = windowRange(scroll.left, viewport.w - ROW_HEADER_W, CELL, colCount)
  const rowStart = Math.min(rowWin.start, focus.r)
  const rowEnd = Math.max(rowWin.end, focus.r + 1)
  const colStart = Math.min(colWin.start, focus.c)
  const colEnd = Math.max(colWin.end, focus.c + 1)

  function moveFocus(nr: number, nc: number) {
    const r = Math.max(0, Math.min(rowCount - 1, nr))
    const c = Math.max(0, Math.min(colCount - 1, nc))
    focusPending.current = true
    setFocus({ r, c })
  }

  function activate(r: number, c: number) {
    const tuple = assignmentFor(r, c)
    const hash = assignmentTupleHash(orderedDimensionIds, tuple)
    const cell = docMap.get(hash)
    if (cell) {
      // Cycle through stacked contexts on repeated activation of the same cell.
      const key = `${r}:${c}`
      const next = ((cycleRef.current.get(key) ?? -1) + 1) % cell.contextIds.length
      cycleRef.current.set(key, next)
      onSelectContext(cell.contextIds[next] as string)
    } else {
      onComposeTuple(tuple)
    }
  }

  function jumpToSymbol(text: string) {
    const target = coverageContexts.find((c) => c.symbol.startsWith(text))
    if (!target) return
    const hash = assignmentTupleHash(orderedDimensionIds, target.bindings)
    if (!docMap.has(hash)) return
    const r = rowParams.findIndex((p) => p.id === target.bindings[rowDimId])
    const c = colParams.findIndex((p) => p.id === target.bindings[colDimId])
    if (r < 0 || c < 0) return
    // Page the filters to the context's own tuple so its cell is on screen.
    const nextFilters: Record<string, string> = { ...filters }
    for (const dimId of filterDims) {
      const p = target.bindings[dimId]
      if (p) nextFilters[dimId] = p
    }
    setFilters(nextFilters)
    moveFocus(r, c)
  }

  function onCellKeyDown(e: React.KeyboardEvent, r: number, c: number) {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault()
        moveFocus(r, c + 1)
        return
      case 'ArrowLeft':
        e.preventDefault()
        moveFocus(r, c - 1)
        return
      case 'ArrowDown':
        e.preventDefault()
        moveFocus(r + 1, c)
        return
      case 'ArrowUp':
        e.preventDefault()
        moveFocus(r - 1, c)
        return
      case 'Home':
        e.preventDefault()
        moveFocus(r, 0)
        return
      case 'End':
        e.preventDefault()
        moveFocus(r, colCount - 1)
        return
    }
    // Type-to-jump: accumulate printable keys briefly, match a context symbol.
    if (e.key.length === 1) {
      const now = Date.now()
      const text = (now - jumpBuffer.current.at < 800 ? jumpBuffer.current.text : '') + e.key
      jumpBuffer.current = { text, at: now }
      jumpToSymbol(text)
    }
  }

  const dimOptions = (excludeId: string) =>
    orderedDimensions
      .filter((d) => d.id !== excludeId)
      .map((d) => ({ value: d.id, label: d.name, color: d.color }))

  function chooseRow(dimId: string) {
    setAxes((prev) => (prev ? { rowDimId: dimId, colDimId: dimId === prev.colDimId ? prev.rowDimId : prev.colDimId } : prev))
  }
  function chooseCol(dimId: string) {
    setAxes((prev) => (prev ? { colDimId: dimId, rowDimId: dimId === prev.rowDimId ? prev.colDimId : prev.rowDimId } : prev))
  }
  function swapAxes() {
    setAxes((prev) => (prev ? { rowDimId: prev.colDimId, colDimId: prev.rowDimId } : prev))
  }

  const gridW = ROW_HEADER_W + colCount * CELL
  const gridH = COL_HEADER_H + rowCount * CELL
  const peek = hoverTuple ?? cellTuple(focus.r, focus.c)

  const visibleRows = Array.from({ length: rowEnd - rowStart }, (_, i) => rowStart + i)
  const visibleCols = Array.from({ length: colEnd - colStart }, (_, i) => colStart + i)

  return (
    <section className="panel coverage-matrix">
      <header className="coverage-matrix__header">
        <p className="coverage-stat coverage-stat--lead font-mono">
          {stat.documented} / {stat.total} documented
        </p>
        <div className="coverage-controls">
          <div className="coverage-axis">
            <span className="coverage-axis__label">Rows</span>
            <Combobox
              value={rowDimId}
              options={dimOptions(colDimId)}
              onChange={(v) => v && chooseRow(v)}
              trigger={
                <Button variant="bare" className="coverage-axis__trigger font-mono">
                  <Swatch color={rowDim?.color} />
                  {rowDim?.name}
                </Button>
              }
            />
          </div>
          <div className="coverage-axis">
            <span className="coverage-axis__label">Columns</span>
            <Combobox
              value={colDimId}
              options={dimOptions(rowDimId)}
              onChange={(v) => v && chooseCol(v)}
              trigger={
                <Button variant="bare" className="coverage-axis__trigger font-mono">
                  <Swatch color={colDim?.color} />
                  {colDim?.name}
                </Button>
              }
            />
          </div>
          <Button variant="bare" className="coverage-swap" title="Swap axes" aria-label="Swap axes" onClick={swapAxes}>
            ⇄
          </Button>
          {filterDims.map((dimId) => {
            const dim = dimById.get(dimId)
            const list = parametersByDimension[dimId] ?? []
            const current = effectiveFilters[dimId]
            const currentName = current ? paramNameById[current] : undefined
            return (
              <Combobox
                key={dimId}
                value={current ?? null}
                // Colors live only in the axis-header swatches (STYLE_GUIDE): a
                // filter chip's options carry no dimension color.
                options={list.map((p) => ({ value: p.id, label: p.name }))}
                onChange={(v) => v && setFilters((f) => ({ ...f, [dimId]: v }))}
                trigger={
                  <Button variant="bare" className="coverage-chip">
                    {dim?.name}: <span className="font-mono">{currentName}</span>
                  </Button>
                }
              />
            )
          })}
        </div>
        <p className="coverage-peek font-mono" aria-live="polite">
          {peek}
        </p>
      </header>

      <div
        className="coverage-grid-scroll"
        ref={scrollRef}
        style={{ maxHeight: VIEWPORT_MAX_H + COL_HEADER_H }}
        onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, left: e.currentTarget.scrollLeft })}
      >
        <div
          className="coverage-grid"
          role="grid"
          aria-rowcount={rowCount}
          aria-colcount={colCount}
          style={{ width: gridW, height: gridH }}
        >
          {/* Corner + header bands stay pinned to the viewport edges by scroll
              offset (translate, not sticky — avoids flow interactions with the
              absolutely-positioned cells). */}
          <div className="coverage-corner" style={{ top: scroll.top, left: scroll.left }} />
          <div className="coverage-colheaders" style={{ top: scroll.top, width: gridW }}>
            {visibleCols.map((c) => (
              <div
                key={c}
                className="coverage-colheader font-mono"
                style={{ left: ROW_HEADER_W + c * CELL }}
                title={colParams[c]?.name}
              >
                <span>{colParams[c]?.name}</span>
              </div>
            ))}
          </div>
          <div className="coverage-rowheaders" style={{ left: scroll.left, height: gridH }}>
            {visibleRows.map((r) => (
              <div
                key={r}
                className="coverage-rowheader font-mono"
                style={{ top: COL_HEADER_H + r * CELL }}
                title={rowParams[r]?.name}
              >
                {rowParams[r]?.name}
              </div>
            ))}
          </div>

          {visibleRows.map((r) =>
            visibleCols.map((c) => {
              const hash = assignmentTupleHash(orderedDimensionIds, assignmentFor(r, c))
              const cell = docMap.get(hash)
              const documented = cell !== undefined
              const symbol = cell?.symbols[0] ?? ''
              const stacked = (cell?.symbols.length ?? 0) > 1
              const isSelected = documented && cell.contextIds.includes(selectedContextId ?? '')
              const label = documented
                ? `${cell.symbols.join(', ')} — ${cellTuple(r, c)}`
                : `Unexplored — ${cellTuple(r, c)}`
              return (
                <Button
                  key={`${r}:${c}`}
                  variant="bare"
                  ref={(el) => {
                    if (el) cellRefs.current.set(`${r}:${c}`, el)
                    else cellRefs.current.delete(`${r}:${c}`)
                  }}
                  role="gridcell"
                  aria-rowindex={r + 1}
                  aria-colindex={c + 1}
                  aria-label={label}
                  aria-selected={isSelected}
                  title={label}
                  data-documented={documented}
                  data-stacked={stacked || undefined}
                  data-selected={isSelected || undefined}
                  data-count={stacked ? cell?.symbols.length : undefined}
                  className="coverage-cell font-mono"
                  style={{ left: ROW_HEADER_W + c * CELL, top: COL_HEADER_H + r * CELL }}
                  tabIndex={r === focus.r && c === focus.c ? 0 : -1}
                  onFocus={() => setFocus({ r, c })}
                  onMouseEnter={() => setHoverTuple(cellTuple(r, c))}
                  onMouseLeave={() => setHoverTuple(null)}
                  onKeyDown={(e) => onCellKeyDown(e, r, c)}
                  onClick={() => activate(r, c)}
                >
                  {documented ? symbol : ''}
                </Button>
              )
            }),
          )}
        </div>
      </div>
    </section>
  )
}
