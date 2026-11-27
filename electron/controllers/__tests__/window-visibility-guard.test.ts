import { describe, expect, it, vi } from 'vitest'

import { installWindowVisibilityGuard } from '../window-visibility-guard'

const PRIMARY = { workArea: { x: 0, y: 0, width: 1707, height: 912 } }

type Bounds = { x: number; y: number; width: number; height: number }
type Listener = () => void

function fakeWindow(bounds: Bounds) {
  const listeners = new Map<string, Listener[]>()
  let current = bounds
  const setBounds = vi.fn((next: Bounds) => { current = next })
  const restore = vi.fn(() => {
    for (const listener of listeners.get('restore') ?? []) listener()
  })

  function fire(event: 'restore' | 'show') {
    for (const listener of listeners.get(event) ?? []) listener()
  }

  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    isMaximized: () => false,
    restore,
    getNormalBounds: () => current,
    setBounds,
    on(event: 'restore' | 'show', listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
  }

  return { window, fire, setBounds, restore, bounds: () => current }
}

describe('window visibility guard', () => {
  it('repairs the placement when the window is restored from the taskbar', () => {
    const { window, fire, setBounds } = fakeWindow({ x: -21333, y: -21333, width: 1552, height: 874 })

    installWindowVisibilityGuard(window, () => [PRIMARY])
    fire('restore')

    expect(setBounds).toHaveBeenCalledWith({ x: 78, y: 19, width: 1552, height: 874 })
  })

  it('repairs on show as well, because a window can come back without a restore', () => {
    const { window, fire, setBounds } = fakeWindow({ x: -21333, y: -21333, width: 1552, height: 874 })

    installWindowVisibilityGuard(window, () => [PRIMARY])
    fire('show')

    expect(setBounds).toHaveBeenCalledOnce()
  })

  it('leaves an on-screen window untouched and does not loop on its own restore', () => {
    const { window, fire, setBounds, restore, bounds } = fakeWindow({
      x: 120, y: 80, width: 1440, height: 800,
    })

    installWindowVisibilityGuard(window, () => [PRIMARY])
    fire('restore')

    expect(restore).toHaveBeenCalledOnce()
    expect(setBounds).not.toHaveBeenCalled()
    expect(bounds()).toEqual({ x: 120, y: 80, width: 1440, height: 800 })
  })

  it('tolerates a window that has no displays to repair against', () => {
    const { window, fire, setBounds } = fakeWindow({ x: -21333, y: -21333, width: 1552, height: 874 })

    installWindowVisibilityGuard(window, () => [])
    fire('restore')

    expect(setBounds).not.toHaveBeenCalled()
  })

  it('ignores a destroyed window', () => {
    const { window, setBounds } = fakeWindow({ x: -21333, y: -21333, width: 1552, height: 874 })
    const guard = installWindowVisibilityGuard({ ...window, isDestroyed: () => true }, () => [PRIMARY])

    guard()

    expect(setBounds).not.toHaveBeenCalled()
  })
})
