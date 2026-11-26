export interface RendererProcessGoneDetails {
  reason: string
  exitCode: number
}

export interface RendererStartupWebContents {
  isDestroyed(): boolean
  on(event: 'render-process-gone', listener: (event: unknown, details: RendererProcessGoneDetails) => void): unknown
  on(event: 'did-finish-load' | 'destroyed', listener: () => void): unknown
  removeListener(event: 'render-process-gone', listener: (event: unknown, details: RendererProcessGoneDetails) => void): unknown
  removeListener(event: 'did-finish-load' | 'destroyed', listener: () => void): unknown
}

export interface RendererStartupWindow {
  isDestroyed(): boolean
  webContents: RendererStartupWebContents
  on(event: 'closed', listener: () => void): unknown
  removeListener(event: 'closed', listener: () => void): unknown
}

export interface RendererStartupFailure {
  reason: string
  exitCode?: number
  message?: string
  attempts: number
}

export interface RendererStartupOptions {
  load(): Promise<unknown>
  onFailure(details: RendererStartupFailure): void
  onRetry?(details: RendererStartupFailure, retry: number): void
}

/**
 * Recover only the first page load. Once did-finish-load fires, this guard must
 * never reload an active editor. A resolved load promise alone is not a page
 * lifecycle signal; stale rejection handlers are fenced by load generation.
 * The returned disposer cancels retries and detaches every listener.
 */
export function loadRendererWithRecovery(window: RendererStartupWindow, options: RendererStartupOptions): () => void {
  const contents = window.webContents
  let active = true
  let generation = 0
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const delays = [250, 1000] as const
  const cleanup = () => {
    active = false
    generation++
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    contents.removeListener('render-process-gone', onGone)
    contents.removeListener('did-finish-load', onLoaded)
    contents.removeListener('destroyed', cleanup)
    window.removeListener('closed', cleanup)
  }
  const alive = () => !window.isDestroyed() && !contents.isDestroyed()
  const failed = (failure: Omit<RendererStartupFailure, 'attempts'>) => {
    if (!active || timer !== undefined) return
    if (!alive()) { cleanup(); return }
    generation++
    const details = { ...failure, attempts }
    const delay = delays[attempts - 1]
    if (delay === undefined) {
      cleanup()
      options.onFailure(details)
      return
    }
    timer = setTimeout(() => {
      timer = undefined
      if (!active) return
      if (!alive()) { cleanup(); return }
      options.onRetry?.(details, attempts)
      startLoad()
    }, delay)
  }
  const startLoad = () => {
    const current = ++generation
    attempts++
    const onRejected = (error: unknown) => {
      if (active && generation === current) failed({ reason: 'load-failed', message: String(error) })
    }
    try {
      void options.load().catch(onRejected)
    } catch (error) { onRejected(error) }
  }
  const onGone = (_event: unknown, details: RendererProcessGoneDetails) => failed(details)
  const onLoaded = () => { if (active && timer === undefined) cleanup() }
  contents.on('render-process-gone', onGone)
  contents.on('did-finish-load', onLoaded)
  contents.on('destroyed', cleanup)
  window.on('closed', cleanup)
  if (alive()) startLoad()
  else cleanup()
  return cleanup
}
