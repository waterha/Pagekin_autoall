import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { ProjectData } from '../../../shared/ipc-channels'
import { useProjectStore } from '../../../stores/project-store'
import { useBlueprintAutomation } from '../../../services/blueprint-automation'
import BlueprintAutomation from '../BlueprintAutomation'
import StageSpine from '../StageSpine'

const actions = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }))
vi.mock('../../../services/blueprint-automation', async importOriginal => ({
  ...await importOriginal<typeof import('../../../services/blueprint-automation')>(),
  startBlueprintAutomation: actions.start, stopBlueprintAutomation: actions.stop,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
const session = { projectId: 'book', leaseId: 'lease', projectPath: 'C:/book' }
beforeEach(async () => {
  vi.clearAllMocks()
  useProjectStore.setState({ currentProject: { id: session.projectId, sessionLease: session.leaseId, path: session.projectPath } as ProjectData })
  useBlueprintAutomation.setState({ session: null, active: false, stopping: false, message: '', error: false, startChapter: null, endChapter: null, total: 12 })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<BlueprintAutomation />))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('蓝图自动化入口', () => {
  it('一键开启并说明每批5章', async () => {
    expect(host.querySelector('button')!.textContent).toBe('蓝图自动化')
    expect(host.textContent).toContain('每批 5 章')
    await userEvent.click(host.querySelector('button')!)
    expect(actions.start).toHaveBeenCalledOnce()
  })

  it('显示当前规划范围和总章数，支持停止', async () => {
    await act(async () => useBlueprintAutomation.setState({ session, active: true, startChapter: 6, endChapter: 10 }))
    expect(host.querySelector('[role=status]')!.textContent).toBe('正在规划第 6–10 章 · 共 12 章')
    expect(host.querySelector('button')!.getAttribute('aria-pressed')).toBe('true')
    await userEvent.click(host.querySelector('button')!)
    expect(actions.stop).toHaveBeenCalledOnce()
    await act(async () => useBlueprintAutomation.setState({ stopping: true }))
    expect(host.querySelector('button')!.disabled).toBe(true)
    expect(host.textContent).toContain('正在停止')
  })

  it('显示错误原因并允许重新开始', async () => {
    await act(async () => useBlueprintAutomation.setState({ session, error: true, message: '本批蓝图规划失败' }))
    expect(host.querySelector('[role=status]')!.getAttribute('data-error')).toBe('true')
    expect(host.textContent).toContain('本批蓝图规划失败')
    expect(host.querySelector('button')!.disabled).toBe(false)
  })

  it('切换作品后不显示旧作品状态，也不启动重叠任务', async () => {
    await act(async () => useBlueprintAutomation.setState({ session: { ...session, leaseId: 'old-lease' }, active: true, message: '旧状态' }))
    expect(host.querySelector('button')!.disabled).toBe(true)
    expect(host.textContent).not.toContain('旧状态')
    expect(host.querySelector('button')!.getAttribute('aria-pressed')).toBe('false')
  })

  it('蓝图和正文入口分别位于对应阶段下方', async () => {
    await act(async () => root.render(<StageSpine
      stages={[
        { stage: 'blueprint', progress: { state: 'todo' }, planned: 0, total: 12 },
        { stage: 'manuscript', progress: { state: 'todo' }, finalized: 0, total: 12 },
      ]}
      chapters={[]} location={null} onStage={vi.fn()} onChapter={vi.fn()} onResource={vi.fn()} onSettings={vi.fn()} />))
    expect(host.querySelector('[data-stage=blueprint]')!.parentElement!.textContent).toContain('蓝图自动化')
    expect(host.querySelector('[data-stage=manuscript]')!.parentElement!.textContent).toContain('正文自动化')
    expect(host.querySelector('[data-stage=manuscript]')!.parentElement!.textContent).not.toContain('蓝图自动化')
  })
})
