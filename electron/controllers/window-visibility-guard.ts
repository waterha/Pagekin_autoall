import {
  ensureWindowVisible,
  type DisplayLike,
  type WindowBounds,
} from '../services/window-visibility'

/**
 * The subset of a browser window this guard needs. Kept structural so the
 * guard carries no Electron import and stays unit-testable.
 */
export interface VisibilityGuardedWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  isMaximized(): boolean
  restore(): void
  getNormalBounds(): WindowBounds
  setBounds(bounds: WindowBounds): void
  on(event: 'restore' | 'show', listener: () => void): void
}

/**
 * Keeps a long-running window reachable.
 *
 * Windows re-applies a window's stored *normal* placement when it is restored
 * from the taskbar. If that placement was ever parked at the minimized
 * sentinel, every later restore puts the window back off-screen: the process
 * keeps running, the taskbar preview stays empty, and no user action recovers
 * it. Repairing right after the restore is what makes the window come back.
 *
 * `restore` also fires for the restore inside `ensureWindowVisible`, so
 * re-entrancy is fenced off; a second pass would only re-read the placement it
 * has already corrected.
 */
export function installWindowVisibilityGuard(
  window: VisibilityGuardedWindow,
  getDisplays: () => readonly DisplayLike[],
): () => void {
  let repairing = false

  const repair = () => {
    if (repairing || window.isDestroyed()) return
    repairing = true
    try {
      ensureWindowVisible(window, getDisplays())
    } finally {
      repairing = false
    }
  }

  window.on('restore', repair)
  window.on('show', repair)

  return repair
}
