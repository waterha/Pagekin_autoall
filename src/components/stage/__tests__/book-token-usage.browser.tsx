import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectData } from '../../../shared/ipc-channels'
import { getLLMStats, type LLMStats } from '../../../services/stats-service'
import { useProjectStore } from '../../../stores/project-store'
import { useLocaleStore } from '../../../stores/locale-store'
import BookTokenUsage from '../BookTokenUsage'

vi.mock('../../../services/stats-service', () => ({ getLLMStats: vi.fn() }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root
const project = (id = 'book', lease = 'lease') => ({ id, sessionLease: lease, path: `C:/${id}` }) as ProjectData
const stats = (): LLMStats => ({ totalCalls: 10, successfulCalls: 9, failedCalls: 1, knownUsageCalls: 10,
  totalTokens: 123456, totalPromptTokens: 100000, totalCompletionTokens: 23456,
  periods: { today: { totalCalls: 2, knownUsageCalls: 2, totalTokens: 1234 }, week: { totalCalls: 5, knownUsageCalls: 5, totalTokens: 12345 } } })
const numbers = () => [...host.querySelectorAll('dd')].map(item => item.textContent)
beforeEach(() => {
  vi.clearAllMocks()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useProjectStore.setState({ currentProject: project() })
  vi.mocked(getLLMStats).mockResolvedValue(stats())
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })
const render = async () => { await act(async () => root.render(<BookTokenUsage />)) }

describe('本书 Token 用量', () => {
  it('shows exact totals for this book, today and this week', async () => {
    await render()
    await vi.waitFor(() => expect(numbers()).toEqual(['123,456', '1,234', '12,345']))
    expect(host.textContent).toContain('周一开始')
    expect(getLLMStats).toHaveBeenCalledWith({ projectId: 'book', leaseId: 'lease', projectPath: 'C:/book' })
  })

  it('marks partial and unknown usage instead of presenting it as a complete total', async () => {
    const data = stats(); data.knownUsageCalls = 9
    data.periods!.today = { totalCalls: 1, knownUsageCalls: 0, totalTokens: null }
    vi.mocked(getLLMStats).mockResolvedValue(data)
    await render()
    await vi.waitFor(() => expect(numbers()).toEqual(['≥ 123,456', '未知', '12,345']))
    expect(host.textContent).toContain('仅统计已知 Token')
  })

  it('shows zero for no calls and updates after the next refresh', async () => {
    const interval = vi.spyOn(window, 'setInterval')
    const data = stats(); data.totalCalls = 0; data.totalTokens = null
    data.periods = { today: { totalCalls: 0, knownUsageCalls: 0, totalTokens: null }, week: { totalCalls: 0, knownUsageCalls: 0, totalTokens: null } }
    vi.mocked(getLLMStats).mockResolvedValue(data)
    await render()
    await vi.waitFor(() => expect(numbers()).toEqual(['0', '0', '0']))
    vi.mocked(getLLMStats).mockResolvedValue(stats())
    await act(async () => { await (interval.mock.calls[0][0] as () => Promise<void>)() })
    await vi.waitFor(() => expect(numbers()[0]).toBe('123,456'))
  })

  it('hides old totals and ignores a delayed response after reopening the same book', async () => {
    let finish!: (value: LLMStats) => void
    vi.mocked(getLLMStats).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await render()
    const next = stats(); next.totalTokens = 987
    vi.mocked(getLLMStats).mockResolvedValue(next)
    await act(async () => useProjectStore.setState({ currentProject: project('book', 'new-lease') }))
    await vi.waitFor(() => expect(numbers()[0]).toBe('987'))
    await act(async () => finish(stats()))
    expect(numbers()[0]).toBe('987')
    await act(async () => useProjectStore.setState({ currentProject: null }))
    expect(host.textContent).toBe('')
  })

  it('reports read failure and recovers on refresh', async () => {
    const interval = vi.spyOn(window, 'setInterval')
    vi.mocked(getLLMStats).mockRejectedValueOnce(new Error('unavailable'))
    await render()
    await vi.waitFor(() => expect(host.textContent).toContain('用量读取失败'))
    expect(numbers()).toEqual(['—', '—', '—'])
    await act(async () => { await (interval.mock.calls[0][0] as () => Promise<void>)() })
    await vi.waitFor(() => expect(numbers()[0]).toBe('123,456'))
    expect(host.textContent).not.toContain('用量读取失败')
  })

  it('translates labels when the interface language changes', async () => {
    await render()
    await act(async () => useLocaleStore.setState({ locale: 'en-US' }))
    expect(host.textContent).toContain('Book token usage')
    expect([...host.querySelectorAll('dt')].map(item => item.textContent)).toEqual(['All time', 'Today', 'This week'])
  })
})
