import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerationOutcome, GenerationSession, GenerationTask } from '../../generation/generation-harness'
import type { StepCallbacks, WorkflowContext } from '../../../stores/workflow-store'
import { withDraftNetworkRetry } from '../draft-network-retry'

const task: GenerationTask = { purpose: 'chapter-draft', output: 'visible-text', messages: [{ role: 'user', content: '既有短细纲与正文要求' }] }
function failure(): GenerationOutcome {
  return { status: 'incomplete', content: '', finishReason: 'error', receipt: {
    failureCode: 'NETWORK_ERROR', finishReason: 'error',
    diagnostics: { startedAt: Date.now(), elapsedMs: 10381, phase: 'request', endReason: 'failed',
      firstResponseMs: null, lastResponseMs: null, lastOutputMs: null, visibleEvents: 0, reasoningEvents: 0, causeCode: 'UND_ERR_CONNECT_TIMEOUT' },
    budget: { attempt: 2, maxAttempts: 32 },
  } as GenerationOutcome['receipt'] }
}
const success = () => ({ ...failure(), status: 'completed', content: '完整正文', finishReason: 'stop', receipt: { ...failure().receipt, failureCode: undefined } }) as GenerationOutcome
function setup() {
  const complete = vi.fn<GenerationSession['complete']>().mockResolvedValue(failure())
  const context = { cancelled: false, uiLocale: 'zh-CN' } as WorkflowContext
  const callbacks = { log: vi.fn() } as unknown as StepCallbacks
  const budget = { deadlineAt: Date.now() + 3600000, maxAttempts: 32, maxRequestedOutputTokens: 2000000, maxRequestedOutputTokensPerAttempt: 65536 }
  const session = withDraftNetworkRetry({ budget, complete }, context, callbacks)
  return { complete, context, callbacks, session }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('正文网络失败自动重试', () => {
  it('以1、2、4秒退避，同一会话内最多重试3次，仍失败返回原收据', async () => {
    const f = setup()
    const running = f.session.complete(task)
    await vi.advanceTimersByTimeAsync(999)
    expect(f.complete).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.complete).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.complete).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(4000)
    expect(f.complete).toHaveBeenCalledTimes(4)
    expect((await running).receipt.failureCode).toBe('NETWORK_ERROR')
    expect(f.callbacks.log).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('成功后不再重试，每次请求保留完全相同任务并使用不同幂等标识', async () => {
    const f = setup()
    f.complete.mockResolvedValueOnce(failure()).mockResolvedValue(success())
    const running = f.session.complete(task, { invocationNonce: 'original' })
    await vi.advanceTimersByTimeAsync(1000)
    expect((await running).content).toBe('完整正文')
    expect(f.complete.mock.calls.map(call => call[0])).toEqual([task, task])
    expect(f.complete.mock.calls.map(call => call[1]?.invocationNonce)).toEqual(['original', 'original:network-retry:1'])
  })

  it('重试额度由本章首稿、续写、压缩共享', async () => {
    const f = setup()
    f.complete.mockResolvedValueOnce(failure()).mockResolvedValueOnce(success())
    const initial = f.session.complete(task)
    await vi.advanceTimersByTimeAsync(1000); await initial
    const continuation = f.session.complete({ ...task, purpose: 'chapter-draft-continuation' })
    await vi.advanceTimersByTimeAsync(6000); await continuation
    const condense = f.session.complete({ ...task, purpose: 'chapter-draft-condense' })
    await condense
    expect(f.complete).toHaveBeenCalledTimes(6)
    expect(f.callbacks.log).toHaveBeenCalledTimes(3)
  })

  it.each(['visible', 'reasoning', 'missing-diagnostics', 'provider', 'storage', 'context-window', 'cancelled', 'in-progress'] as const)('%s不触发盲目重试', async kind => {
    const f = setup()
    const result = failure()
    if (kind === 'visible') result.content = '已生成的部分正文'
    if (kind === 'reasoning') result.receipt.diagnostics!.reasoningEvents = 1
    if (kind === 'missing-diagnostics') delete result.receipt.diagnostics
    if (kind === 'provider') result.receipt.failureCode = 'GENERATION_PROVIDER_FAILED'
    if (kind === 'storage') result.receipt.failureCode = 'GENERATION_STORAGE_FAILED'
    if (kind === 'context-window') result.receipt.failureCode = 'GENERATION_CONTEXT_LENGTH_EXCEEDED'
    if (kind === 'cancelled') f.context.cancelled = true
    if (kind === 'in-progress') delete result.receipt.diagnostics!.endReason
    f.complete.mockResolvedValue(result)
    await expect(f.session.complete(task)).resolves.toBe(result)
    expect(f.complete).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('IPC拒绝时结果未知，不再次发送模型请求', async () => {
    const f = setup()
    f.complete.mockRejectedValue(new Error('IPC连接中断'))
    await expect(f.session.complete(task)).rejects.toThrow('IPC连接中断')
    expect(f.complete).toHaveBeenCalledOnce()
  })

  it('等待期间可立即取消，清理计时器且不再发送', async () => {
    const f = setup()
    const controller = new AbortController()
    const running = f.session.complete(task, { signal: controller.signal }).catch(error => error)
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()
    expect((await running).message).toContain('已取消')
    expect(f.complete).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['attempts', 'deadline'] as const)('尊重原调用账本的%s限制', async limit => {
    const f = setup()
    if (limit === 'attempts') f.complete.mockResolvedValue({ ...failure(), receipt: { ...failure().receipt, budget: { ...failure().receipt.budget, attempt: 32 } } })
    else Object.assign(f.session.budget, { deadlineAt: Date.now() + 500 })
    await f.session.complete(task)
    expect(f.complete).toHaveBeenCalledOnce()
  })

  it('不绕过短细纲自己的重试准入', async () => {
    const f = setup()
    await f.session.complete({ ...task, purpose: 'chapter-draft-short-outline' })
    expect(f.complete).toHaveBeenCalledOnce()
  })
})
