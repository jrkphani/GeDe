// A pure fixed-pitch 1-D windowing helper backing the coverage matrix's
// virtualization (issue 012, TECH_STACK T2). The coverage grid is a uniform
// 24px pitch on both axes, so windowing is exact integer math rather than the
// measured/variable-size case @tanstack/react-virtual is built for — kept a
// pure function for the same reason canvasLayout/composeMode are: unit-testable
// in isolation, no React, and it can never desync from a scroll event.

export interface WindowRange {
  // Half-open [start, end): indices to render, plus overscan on each side.
  start: number
  end: number
}

export function windowRange(
  scrollOffset: number,
  viewportSize: number,
  cellSize: number,
  count: number,
  overscan = 4,
): WindowRange {
  if (count <= 0 || cellSize <= 0) return { start: 0, end: 0 }
  const clampedScroll = Math.max(0, scrollOffset)
  const first = Math.floor(clampedScroll / cellSize) - overscan
  const last = Math.ceil((clampedScroll + Math.max(0, viewportSize)) / cellSize) + overscan
  return {
    start: Math.max(0, first),
    end: Math.min(count, Math.max(0, last)),
  }
}
