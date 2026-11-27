import {
  ensureWindowVisible,
  type DisplayLike,
  type RepairableWindow,
} from './window-visibility'

export interface SingleInstanceWindow extends RepairableWindow {
  show(): void
  focus(): void
}

export interface SingleInstanceRuntimeOptions {
  releaseSmokeRequested: boolean
  requestLock(): boolean
  quit(): void
  onSecondInstance(listener: () => void): void
  getWindow(): SingleInstanceWindow | null | undefined
  getDisplays?(): readonly DisplayLike[]
}

/**
 * Raised from the taskbar, a second launch has to undo a stale off-screen
 * placement as well as un-minimize: `restore()` alone re-applies the placement
 * Windows remembers, which can be the minimized sentinel.
 */
export function focusExistingInstance(
  window: SingleInstanceWindow | null | undefined,
  displays: readonly DisplayLike[] = [],
): void {
  if (!window || window.isDestroyed()) return
  ensureWindowVisible(window, displays)
  window.show()
  window.focus()
}

/**
 * Release qualification processes deliberately bypass the interactive lock so
 * architecture-specific smoke jobs can run independently. Ordinary launches
 * are single-instance and the second process exits before startup work begins.
 */
export function configureSingleInstanceRuntime(options: SingleInstanceRuntimeOptions): boolean {
  if (options.releaseSmokeRequested) return true
  if (!options.requestLock()) {
    options.quit()
    return false
  }
  options.onSecondInstance(() => {
    focusExistingInstance(options.getWindow(), options.getDisplays?.() ?? [])
  })
  return true
}
