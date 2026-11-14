import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { ProjectData } from '../../../shared/ipc-channels'
import { useProjectStore } from '../../../stores/project-store'
import { useManuscriptAutomation } from '../../../services/manuscript-automation'
import ManuscriptAutomation from '../ManuscriptAutomation'

const actions = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }))
vi.mock('../../../services/manuscript-automation', async importOriginal => ({
  ...await importOriginal<typeof import('../../../services/manuscript-automation')>(),
  startManuscriptAutomation: actions.start, stopManuscriptAutomation: actions.stop,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
const session = { projectId: 'book', leaseId: 'lease', projectPath: 'C:/book' }
beforeEach(async () => {
  vi.clearAllMocks()
  useProjectStore.setState({ currentProject: { id: session.projectId, sessionLease: session.leaseId, path: session.projectPath } as ProjectData })
  useManuscriptAutomation.setState({ session: null, active: false, stopping: false, message: '', error: false, phase: 'preparing', chapter: null })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<ManuscriptAutomation />))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('正文自动化入口', () => {
  it('一键开启，提示会自动采纳全部审稿意见', async () => {
    const button = host.querySelector('button')!
    expect(button.textContent).toBe('正文自动化')
    expect(host.textContent).toContain('自动采纳全部审稿意见')
    await userEvent.click(button)
    expect(actions.start).toHaveBeenCalledOnce()
  })

  it('显示章节及阶段，点击后停止；停止期间禁用按钮', async () => {
    await act(async () => useManuscriptAutomation.setState({ session, active: true, chapter: 3, phase: 'revising' }))
    expect(host.querySelector('[role=status]')!.textContent).toBe('第 3 章 · 修稿')
    expect(host.querySelector('button')!.getAttribute('aria-pressed')).toBe('true')
    await userEvent.click(host.querySelector('button')!)
    expect(actions.stop).toHaveBeenCalledOnce()
    await act(async () => useManuscriptAutomation.setState({ stopping: true }))
    expect(host.querySelector('button')!.disabled).toBe(true)
    expect(host.textContent).toContain('正在停止')
  })

  it('结束后显示失败原因并恢复开启按钮', async () => {
    await act(async () => useManuscriptAutomation.setState({ session, active: false, error: true, message: '模型调用失败' }))
    expect(host.querySelector('button')!.textContent).toBe('正文自动化')
    expect(host.querySelector('[role=status]')!.getAttribute('data-error')).toBe('true')
    expect(host.textContent).toContain('模型调用失败')
  })

  it('重试后处理时显示章节和重试轮数，仍可停止', async () => {
    await act(async () => useManuscriptAutomation.setState({ session, active: true, chapter: 3, phase: 'retrying', retryAttempt: 2 }))
    expect(host.querySelector('[role=status]')!.textContent).toBe('第 3 章 · 自动重试失败步骤（2/3）')
    await userEvent.click(host.querySelector('button')!)
    expect(actions.stop).toHaveBeenCalledOnce()
  })
})
