import { describe, expect, it } from 'vitest'
import {
  coreDepth,
  rectsIntersect,
  shouldCoreBeLive,
  viewportRect,
  type CoreLodConfig,
  type CoreLodInput,
  type Rect,
} from './coreLod'

// Issue 106 item 1 — the pure culling calculus for zoom-LOD auto-demotion of a
// drilled-in child core. Deterministic (no DOM/Date/store), so every axis is
// unit-testable in isolation.

const CONFIG: CoreLodConfig = { minZoom: 0.35, maxLiveDepth: 2, offscreenMargin: 100 }

// A core rect sitting comfortably inside a viewport that spans the origin.
const IN_VIEW: Rect = { x: 10, y: 10, width: 50, height: 50 }
const VIEWPORT: Rect = { x: 0, y: 0, width: 200, height: 200 }

function input(over: Partial<CoreLodInput>): CoreLodInput {
  return {
    zoom: 1,
    depth: 0,
    coreRect: IN_VIEW,
    viewportRect: VIEWPORT,
    isEditing: false,
    ...over,
  }
}

describe('rectsIntersect', () => {
  const a: Rect = { x: 0, y: 0, width: 10, height: 10 }

  it('is true for overlapping rects', () => {
    expect(rectsIntersect(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true)
  })

  it('is false for disjoint rects', () => {
    expect(rectsIntersect(a, { x: 100, y: 100, width: 10, height: 10 })).toBe(false)
  })

  it('treats edge-touching as NOT intersecting at margin 0 (strict edges)', () => {
    // a's right edge (x=10) exactly meets b's left edge (x=10).
    expect(rectsIntersect(a, { x: 10, y: 0, width: 10, height: 10 })).toBe(false)
  })

  it('counts a near-miss as intersecting once within margin', () => {
    const nearMiss: Rect = { x: 13, y: 0, width: 10, height: 10 } // 3px gap from a
    expect(rectsIntersect(a, nearMiss)).toBe(false)
    expect(rectsIntersect(a, nearMiss, 5)).toBe(true)
  })

  it('defaults margin to 0 when omitted', () => {
    const nearMiss: Rect = { x: 11, y: 0, width: 10, height: 10 }
    expect(rectsIntersect(a, nearMiss)).toBe(false)
  })
})

describe('viewportRect', () => {
  it('maps an identity transform to the pane dimensions at the origin', () => {
    // -tx/zoom of a zero translate is JS's negative zero; -0 compares/arithmetics
    // identically to 0 for every downstream rect test, so the wart is harmless.
    expect(viewportRect([0, 0, 1], 800, 600)).toEqual({ x: -0, y: -0, width: 800, height: 600 })
  })

  it('accounts for zoom (a zoomed-in pane sees fewer flow units)', () => {
    expect(viewportRect([0, 0, 2], 800, 600)).toEqual({ x: -0, y: -0, width: 400, height: 300 })
  })

  it('accounts for pan (translate shifts the visible flow-coord origin)', () => {
    // transform [tx, ty, zoom]: origin = -t / zoom.
    expect(viewportRect([-100, -50, 1], 800, 600)).toEqual({
      x: 100,
      y: 50,
      width: 800,
      height: 600,
    })
  })

  it('composes zoom + pan', () => {
    expect(viewportRect([-200, -100, 2], 800, 600)).toEqual({
      x: 100,
      y: 50,
      width: 400,
      height: 300,
    })
  })
})

describe('shouldCoreBeLive', () => {
  it('is live when in-view, shallow, zoomed-in, and not editing', () => {
    expect(shouldCoreBeLive(input({}), CONFIG)).toBe(true)
  })

  describe('editing overrides every demote axis', () => {
    it('stays live while editing even when zoomed out', () => {
      expect(shouldCoreBeLive(input({ isEditing: true, zoom: 0.1 }), CONFIG)).toBe(true)
    })
    it('stays live while editing even when off-screen', () => {
      expect(
        shouldCoreBeLive(
          input({ isEditing: true, coreRect: { x: 10000, y: 10000, width: 50, height: 50 } }),
          CONFIG,
        ),
      ).toBe(true)
    })
    it('stays live while editing even when too deep', () => {
      expect(shouldCoreBeLive(input({ isEditing: true, depth: 9 }), CONFIG)).toBe(true)
    })
  })

  describe('zoom axis', () => {
    it('demotes below minZoom', () => {
      expect(shouldCoreBeLive(input({ zoom: 0.34 }), CONFIG)).toBe(false)
    })
    it('stays live exactly at minZoom (boundary is inclusive-live)', () => {
      expect(shouldCoreBeLive(input({ zoom: 0.35 }), CONFIG)).toBe(true)
    })
  })

  describe('depth axis', () => {
    it('stays live exactly at maxLiveDepth', () => {
      expect(shouldCoreBeLive(input({ depth: 2 }), CONFIG)).toBe(true)
    })
    it('demotes one past maxLiveDepth', () => {
      expect(shouldCoreBeLive(input({ depth: 3 }), CONFIG)).toBe(false)
    })
  })

  describe('off-screen axis', () => {
    it('demotes when the core is beyond the viewport + margin', () => {
      expect(
        shouldCoreBeLive(input({ coreRect: { x: 10000, y: 10000, width: 50, height: 50 } }), CONFIG),
      ).toBe(false)
    })
    it('stays live when just off-edge but within the margin', () => {
      // Viewport right edge = 200; core sits 50px past it → within the 100 margin.
      expect(
        shouldCoreBeLive(input({ coreRect: { x: 250, y: 10, width: 50, height: 50 } }), CONFIG),
      ).toBe(true)
    })
    it('demotes once the core clears the viewport + margin', () => {
      // Viewport right edge = 200 + 100 margin = 300; core left edge at 301 clears it.
      expect(
        shouldCoreBeLive(input({ coreRect: { x: 301, y: 10, width: 50, height: 50 } }), CONFIG),
      ).toBe(false)
    })
  })
})

describe('coreDepth', () => {
  const primary: { contextId: string; parentCoreId: string | null }[] = [
    { contextId: 'a', parentCoreId: null }, // direct child of the primary
    { contextId: 'b', parentCoreId: 'a' }, // grandchild
    { contextId: 'c', parentCoreId: 'b' }, // great-grandchild
  ]

  it('is 0 for a direct child (parentCoreId null)', () => {
    expect(coreDepth(primary, 'a')).toBe(0)
  })

  it('is 1 for a grandchild', () => {
    expect(coreDepth(primary, 'b')).toBe(1)
  })

  it('is 2 for a great-grandchild', () => {
    expect(coreDepth(primary, 'c')).toBe(2)
  })

  it('is 0 for an unknown context id', () => {
    expect(coreDepth(primary, 'zzz')).toBe(0)
  })

  it('terminates on a cyclic parent chain (visited guard)', () => {
    const cyclic = [
      { contextId: 'x', parentCoreId: 'y' },
      { contextId: 'y', parentCoreId: 'x' },
    ]
    // x → y → x: the visited guard stops after counting each node once, so the
    // deterministic depth is exactly 2 (not merely finite).
    expect(coreDepth(cyclic, 'x')).toBe(2)
  })
})
