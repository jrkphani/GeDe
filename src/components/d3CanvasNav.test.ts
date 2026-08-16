// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetActiveLane, useActiveLaneStore } from '../store/activeLane'
import {
  clearActiveCanvasInstance,
  LANE_NODE_ID,
  setActiveCanvasInstance,
  type CanvasNavInstance,
} from './d3CanvasNav'

describe('canvas lane shortcuts own position, not zoom', () => {
  let panToNode: ReturnType<typeof vi.fn>
  let instance: CanvasNavInstance

  beforeEach(() => {
    resetActiveLane()
    panToNode = vi.fn()
    instance = { panToNode }
    setActiveCanvasInstance(instance)
  })

  afterEach(() => {
    clearActiveCanvasInstance(instance)
    vi.unstubAllGlobals()
  })

  it('Cmd+2 asks for a position-only pan to Architecture', () => {
    const event = new KeyboardEvent('keydown', {
      code: 'Digit2',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })

    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(panToNode).toHaveBeenCalledWith(LANE_NODE_ID.architecture, 450)
    expect(useActiveLaneStore.getState().activeLane).toBe('architecture')
  })

  it('snaps the position-only pan under reduced motion', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: true }),
    )

    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        code: 'Digit3',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )

    expect(panToNode).toHaveBeenCalledWith(LANE_NODE_ID.design, 0)
  })
})
