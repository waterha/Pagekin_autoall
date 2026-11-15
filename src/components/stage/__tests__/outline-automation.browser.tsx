import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { ProjectData } from '../../../shared/ipc-channels'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'
import { useOutlineAutomation } from '../../../services/outline-automation'
import OutlineAutomation from '../OutlineAutomation'

const actions = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }))
vi.mock('../../../services/outline-automation', async importOriginal => ({
  ...await importOriginal<typeof import('../../../services/outline-automation')>(),
  startOutlineAutomation: actions.start, stopOutlineAutomation: actions.stop,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let host: HTMLDivElement
const session = { projectId: 'book', leaseId: 'lease', projectPath: 'C:/book' }
beforeEach(async () => {
  vi.clearAllMocks()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: { id: session.projectId, sessionLease: session.leaseId, path: session.projectPath } as ProjectData })
  useOutlineAutomation.setState({ session: null, active: false, stopping: false, message: '', error: false, startChapter: null, endChapter: null, total: 12, phase: 'generating' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<OutlineAutomation />))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('情节大纲自动化入口', () => {
  it('自动保存、恢复和重试过程直接显示当前操作', async () => {
    for (const phase of ['saving', 'recovering', 'retrying'] as const) {
      await act(async () => useOutlineAutomation.setState({ session, active: true, phase, message: `当前操作：${phase}` }))
      expect(host.querySelector('[role=status]')!.textContent).toBe(`当前操作：${phase}`)
      expect(host.querySelector('button')!.disabled).toBe(false)
    }
  })
  it('一键开启并说明每批5章', async () => {
    expect(host.querySelector('button')!.textContent).toBe('大纲自动化')
    expect(host.textContent).toContain('每批 5 章')
    await userEvent.click(host.querySelector('button')!)
    expect(actions.start).toHaveBeenCalledOnce()
  })

  it('显示当前范围和总章数，支持停止', async () => {
    await act(async () => useOutlineAutomation.setState({ session, active: true, startChapter: 6, endChapter: 10 }))
    expect(host.querySelector('[role=status]')!.textContent).toBe('正在生成第 6–10 章大纲 · 共 12 章')
    expect(host.querySelector('button')!.getAttribute('aria-pressed')).toBe('true')
    await userEvent.click(host.querySelector('button')!)
    expect(actions.stop).toHaveBeenCalledOnce()
    await act(async () => useOutlineAutomation.setState({ stopping: true }))
    expect(host.querySelector('button')!.disabled).toBe(true)
    expect(host.textContent).toContain('正在停止')
  })

  it('错误原因可见，允许重新开始', async () => {
    await act(async () => useOutlineAutomation.setState({ session, error: true, message: '本批大纲未完成' }))
    expect(host.querySelector('[role=status]')!.getAttribute('data-error')).toBe('true')
    expect(host.textContent).toContain('本批大纲未完成')
    expect(host.querySelector('button')!.disabled).toBe(false)
  })

  it('切换作品后隐藏旧状态并禁用重叠启动', async () => {
    await act(async () => useOutlineAutomation.setState({ session: { ...session, leaseId: 'old-lease' }, active: true, message: '旧状态' }))
    expect(host.querySelector('button')!.disabled).toBe(true)
    expect(host.textContent).not.toContain('旧状态')
    expect(host.querySelector('button')!.getAttribute('aria-pressed')).toBe('false')
  })

  it('准备阶段和完成阶段都有说明，无作品时无法启动', async () => {
    await act(async () => useOutlineAutomation.setState({ session, active: true }))
    expect(host.textContent).toContain('正在准备情节大纲')
    await act(async () => useOutlineAutomation.setState({ active: false, message: '情节大纲已全部完成（共 12 章）。' }))
    expect(host.textContent).toContain('已全部完成')
    await act(async () => useProjectStore.setState({ currentProject: null }))
    expect(host.querySelector('button')!.disabled).toBe(true)
  })
})
