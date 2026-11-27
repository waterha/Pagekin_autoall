export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayLike {
  workArea: WindowBounds
}

export interface RepairableWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  isMaximized(): boolean
  restore(): void
  getNormalBounds(): WindowBounds
  setBounds(bounds: WindowBounds): void
}

/**
 * Windows parks a minimized window at a large negative sentinel position: -32000
 * in physical pixels, reported as -21333 at 150% scaling. Chromium can persist
 * that sentinel as the window's *normal* placement, and a window restored from
 * such a placement reappears completely off-screen: the application keeps
 * running, but no user action brings it back. The threshold is deliberately far
 * below any plausible left-of-primary monitor arrangement.
 */
const OFF_SCREEN_SENTINEL = -10_000

/**
 * A window is treated as reachable once this share of it is inside a display's
 * work area. Anything less keeps the title bar out of reach and looks "gone".
 */
export const MINIMUM_VISIBLE_RATIO = 0.25

function isFiniteBounds(bounds: WindowBounds | null | undefined): bounds is WindowBounds {
  if (!bounds) return false
  return Number.isFinite(bounds.x)
    && Number.isFinite(bounds.y)
    && Number.isFinite(bounds.width)
    && Number.isFinite(bounds.height)
}

function workAreasOf(displays: readonly DisplayLike[] | null | undefined): WindowBounds[] {
  if (!displays) return []
  const workAreas: WindowBounds[] = []
  for (const display of displays) {
    if (display && isFiniteBounds(display.workArea)) workAreas.push(display.workArea)
  }
  return workAreas
}

function clampedSize(bounds: WindowBounds, workArea: WindowBounds): { width: number; height: number } {
  return {
    width: Math.max(1, Math.min(Math.abs(bounds.width), workArea.width)),
    height: Math.max(1, Math.min(Math.abs(bounds.height), workArea.height)),
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (maximum < minimum) return minimum
  return Math.min(Math.max(value, minimum), maximum)
}

function intersectionArea(a: WindowBounds, b: WindowBounds): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (width <= 0 || height <= 0) return 0
  return width * height
}

export function isOffScreenSentinel(bounds: WindowBounds | null | undefined): boolean {
  if (!isFiniteBounds(bounds)) return true
  return bounds.x <= OFF_SCREEN_SENTINEL || bounds.y <= OFF_SCREEN_SENTINEL
}

/**
 * Share (0…1) of the window that is inside some display's work area.
 */
export function visibleAreaRatio(
  bounds: WindowBounds | null | undefined,
  displays: readonly DisplayLike[] | null | undefined,
): number {
  if (!isFiniteBounds(bounds)) return 0
  const area = Math.abs(bounds.width) * Math.abs(bounds.height)
  if (area <= 0) return 0
  let visible = 0
  for (const workArea of workAreasOf(displays)) visible += intersectionArea(bounds, workArea)
  return Math.min(1, visible / area)
}

function bestWorkArea(
  bounds: WindowBounds | null | undefined,
  workAreas: readonly WindowBounds[],
): WindowBounds | null {
  if (!workAreas.length) return null
  if (!isFiniteBounds(bounds)) return workAreas[0]
  let best = workAreas[0]
  let bestArea = 0
  for (const workArea of workAreas) {
    const area = intersectionArea(bounds, workArea)
    if (area > bestArea) {
      bestArea = area
      best = workArea
    }
  }
  return best
}

/**
 * Returns bounds that are fully inside one display's work area. A sentinel
 * position is not a real place, so such a window keeps its size but is centred
 * on the best display instead of reusing the off-screen coordinates.
 */
export function fitBoundsToDisplay(
  bounds: WindowBounds | null | undefined,
  displays: readonly DisplayLike[] | null | undefined,
): WindowBounds | null {
  const workAreas = workAreasOf(displays)
  if (!workAreas.length) return null
  const hasSize = isFiniteBounds(bounds)
  const hasPlacement = hasSize && !isOffScreenSentinel(bounds)
  const workArea = bestWorkArea(hasPlacement ? bounds : null, workAreas) ?? workAreas[0]
  const { width, height } = hasSize
    ? clampedSize(bounds, workArea)
    : { width: workArea.width, height: workArea.height }
  const x = hasPlacement
    ? clamp(bounds.x, workArea.x, workArea.x + workArea.width - width)
    : workArea.x + Math.round((workArea.width - width) / 2)
  const y = hasPlacement
    ? clamp(bounds.y, workArea.y, workArea.y + workArea.height - height)
    : workArea.y + Math.round((workArea.height - height) / 2)
  return { x, y, width, height }
}

/**
 * Repaired bounds, or null when the window is already reachable. Callers use
 * the null result to avoid pointless `setBounds` calls on every show/restore.
 */
export function repairWindowBounds(
  bounds: WindowBounds | null | undefined,
  displays: readonly DisplayLike[] | null | undefined,
  minimumVisibleRatio: number = MINIMUM_VISIBLE_RATIO,
): WindowBounds | null {
  if (!workAreasOf(displays).length) return null
  if (isFiniteBounds(bounds) && !isOffScreenSentinel(bounds)) {
    if (visibleAreaRatio(bounds, displays) >= minimumVisibleRatio) return null
  }
  return fitBoundsToDisplay(bounds, displays)
}

/**
 * Restores a minimized window and then repairs its placement. The restore has
 * to come first: it is the moment the stale placement is applied, and Windows
 * ignores (or defers) position writes on a minimized window.
 *
 * Returns true when the window bounds were changed.
 */
export function ensureWindowVisible(
  window: RepairableWindow | null | undefined,
  displays: readonly DisplayLike[] | null | undefined,
): boolean {
  if (!window || window.isDestroyed()) return false
  // Read the normal placement *before* restoring: restoring is precisely what
  // re-applies the stale placement, and Windows ignores position writes while
  // the window is still minimized.
  const repaired = repairWindowBounds(window.getNormalBounds(), displays)
  if (window.isMinimized()) window.restore()
  if (!repaired || window.isMaximized()) return false
  window.setBounds(repaired)
  return true
}
