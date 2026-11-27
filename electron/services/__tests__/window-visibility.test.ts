import { describe, expect, it, vi } from 'vitest'

import {
  ensureWindowVisible,
  fitBoundsToDisplay,
  isOffScreenSentinel,
  repairWindowBounds,
  visibleAreaRatio,
  type RepairableWindow,
  type WindowBounds,
} from '../window-visibility'

// The user's machine: one 1707x912 work area at 150% scaling, so Windows parks
// minimized windows at -21333 instead of -32000.
const PRIMARY = { workArea: { x: 0, y: 0, width: 1707, height: 912 } }
const SENTINEL = { x: -21333, y: -21333, width: 1552, height: 874 }
const ON_SCREEN = { x: 120, y: 80, width: 1440, height: 800 }

function fakeWindow(bounds: WindowBounds, options: {
  minimized?: boolean
  maximized?: boolean
  destroyed?: boolean
} = {}) {
  let current = { ...bounds }
  let minimized = options.minimized ?? false
  const setBounds = vi.fn((next: WindowBounds) => { current = { ...next } })
  const restore = vi.fn(() => { minimized = false })
  const window: RepairableWindow = {
    isDestroyed: () => options.destroyed ?? false,
    isMinimized: () => minimized,
    isMaximized: () => options.maximized ?? false,
    restore,
    getNormalBounds: () => ({ ...current }),
    setBounds,
  }
  return { window, setBounds, restore, bounds: () => current, isMinimized: () => minimized }
}

describe('window visibility repair', () => {
  it('treats the Windows minimized sentinel as off-screen', () => {
    expect(isOffScreenSentinel(SENTINEL)).toBe(true)
    expect(isOffScreenSentinel({ x: -32000, y: -32000, width: 100, height: 100 })).toBe(true)
    expect(isOffScreenSentinel(ON_SCREEN)).toBe(false)
    expect(isOffScreenSentinel(null)).toBe(true)
  })

  it('reports the share of a window that is inside a display work area', () => {
    expect(visibleAreaRatio(ON_SCREEN, [PRIMARY])).toBe(1)
    expect(visibleAreaRatio(SENTINEL, [PRIMARY])).toBe(0)
    // 100px of a 1000px-wide window pokes into the work area.
    expect(visibleAreaRatio({ x: -900, y: 0, width: 1000, height: 100 }, [PRIMARY])).toBeCloseTo(0.1)
    expect(visibleAreaRatio(ON_SCREEN, [])).toBe(0)
  })

  it('moves a sentinel placement back onto the primary work area', () => {
    const repaired = repairWindowBounds(SENTINEL, [PRIMARY])
    expect(repaired).not.toBeNull()
    expect(repaired).toEqual({ x: 78, y: 19, width: 1552, height: 874 })
    expect(visibleAreaRatio(repaired, [PRIMARY])).toBe(1)
  })

  it('leaves an already reachable window alone so show/restore stays cheap', () => {
    expect(repairWindowBounds(ON_SCREEN, [PRIMARY])).toBeNull()
  })

  it('pulls back a window whose title bar is out of reach', () => {
    const barelyVisible = { x: -1200, y: 0, width: 1440, height: 900 }
    const repaired = repairWindowBounds(barelyVisible, [PRIMARY])
    expect(repaired).not.toBeNull()
    expect(repaired!.x).toBe(0)
    expect(visibleAreaRatio(repaired, [PRIMARY])).toBeGreaterThanOrEqual(0.25)
  })

  it('keeps a window fully inside a secondary display without moving it to the primary one', () => {
    const secondary = { workArea: { x: 1707, y: 0, width: 1920, height: 1080 } }
    const onSecondary = { x: 1800, y: 100, width: 1200, height: 800 }
    expect(repairWindowBounds(onSecondary, [PRIMARY, secondary])).toBeNull()
    const straddling = { x: 3400, y: 100, width: 1200, height: 800 }
    expect(repairWindowBounds(straddling, [PRIMARY, secondary])).toEqual({
      x: 2427, y: 100, width: 1200, height: 800,
    })
  })

  it('shrinks a window that no longer fits the current work area', () => {
    const huge = { x: 0, y: 0, width: 3000, height: 2000 }
    const repaired = fitBoundsToDisplay(huge, [PRIMARY])
    expect(repaired).toEqual({ x: 0, y: 0, width: 1707, height: 912 })
  })

  it('does nothing without display information', () => {
    expect(repairWindowBounds(SENTINEL, [])).toBeNull()
    expect(repairWindowBounds(SENTINEL, null)).toBeNull()
    expect(fitBoundsToDisplay(SENTINEL, [])).toBeNull()
  })

  it('restores a minimized window and applies the repaired placement', () => {
    const harness = fakeWindow(SENTINEL, { minimized: true })

    expect(ensureWindowVisible(harness.window, [PRIMARY])).toBe(true)

    expect(harness.restore).toHaveBeenCalledOnce()
    expect(harness.setBounds).toHaveBeenCalledOnce()
    expect(harness.isMinimized()).toBe(false)
    expect(harness.bounds()).toEqual({ x: 78, y: 19, width: 1552, height: 874 })
  })

  it('still restores a minimized window that is already on screen', () => {
    const harness = fakeWindow(ON_SCREEN, { minimized: true })

    expect(ensureWindowVisible(harness.window, [PRIMARY])).toBe(false)

    expect(harness.restore).toHaveBeenCalledOnce()
    expect(harness.setBounds).not.toHaveBeenCalled()
  })

  it('never rewrites the bounds of a maximized window', () => {
    const harness = fakeWindow(SENTINEL, { maximized: true })

    expect(ensureWindowVisible(harness.window, [PRIMARY])).toBe(false)

    expect(harness.setBounds).not.toHaveBeenCalled()
  })

  it('ignores destroyed windows', () => {
    const harness = fakeWindow(ON_SCREEN, { destroyed: true })

    expect(ensureWindowVisible(harness.window, [PRIMARY])).toBe(false)
    expect(harness.restore).not.toHaveBeenCalled()
    expect(harness.setBounds).not.toHaveBeenCalled()
  })
})
