import { describe, expect, it, vi } from 'vitest'

import { configureSingleInstanceRuntime } from '../single-instance-runtime'

const PRIMARY = { workArea: { x: 0, y: 0, width: 1707, height: 912 } }

function hiddenWindow(normalBounds: { x: number; y: number; width: number; height: number }) {
  const restore = vi.fn()
  const show = vi.fn()
  const focus = vi.fn()
  const setBounds = vi.fn()
  return {
    restore,
    show,
    focus,
    setBounds,
    window: {
      isDestroyed: () => false,
      isMinimized: () => true,
      isMaximized: () => false,
      restore,
      getNormalBounds: () => normalBounds,
      setBounds,
      show,
      focus,
    },
  }
}

describe('single-instance runtime', () => {
  it('does not interfere with isolated packaged release smoke processes', () => {
    const requestLock = vi.fn(() => false)
    const quit = vi.fn()
    const onSecondInstance = vi.fn()

    expect(configureSingleInstanceRuntime({
      releaseSmokeRequested: true,
      requestLock,
      quit,
      onSecondInstance,
      getWindow: () => null,
    })).toBe(true)
    expect(requestLock).not.toHaveBeenCalled()
    expect(quit).not.toHaveBeenCalled()
    expect(onSecondInstance).not.toHaveBeenCalled()
  })

  it('quits an ordinary secondary instance before startup work begins', () => {
    const quit = vi.fn()
    const onSecondInstance = vi.fn()

    expect(configureSingleInstanceRuntime({
      releaseSmokeRequested: false,
      requestLock: () => false,
      quit,
      onSecondInstance,
      getWindow: () => null,
    })).toBe(false)
    expect(quit).toHaveBeenCalledOnce()
    expect(onSecondInstance).not.toHaveBeenCalled()
  })

  it('restores and focuses the primary window after a second launch', () => {
    let listener: (() => void) | undefined
    const { window, restore, show, focus, setBounds } = hiddenWindow({
      x: 120, y: 80, width: 1440, height: 800,
    })

    expect(configureSingleInstanceRuntime({
      releaseSmokeRequested: false,
      requestLock: () => true,
      quit: vi.fn(),
      onSecondInstance: next => { listener = next },
      getWindow: () => window,
      getDisplays: () => [PRIMARY],
    })).toBe(true)

    listener?.()
    expect(restore).toHaveBeenCalledOnce()
    expect(show).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledOnce()
    expect(setBounds).not.toHaveBeenCalled()
  })

  // Regression: the window's normal placement can be parked at the Windows
  // minimized sentinel, which is how a long-running window ends up running yet
  // impossible to bring back. Restoring alone re-applies that placement.
  it('pulls a sentinel-placed window back onto a display after a second launch', () => {
    let listener: (() => void) | undefined
    const { window, setBounds, show, focus } = hiddenWindow({
      x: -21333, y: -21333, width: 1552, height: 874,
    })

    configureSingleInstanceRuntime({
      releaseSmokeRequested: false,
      requestLock: () => true,
      quit: vi.fn(),
      onSecondInstance: next => { listener = next },
      getWindow: () => window,
      getDisplays: () => [PRIMARY],
    })

    listener?.()
    expect(setBounds).toHaveBeenCalledWith({ x: 78, y: 19, width: 1552, height: 874 })
    expect(show).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledOnce()
  })
})
