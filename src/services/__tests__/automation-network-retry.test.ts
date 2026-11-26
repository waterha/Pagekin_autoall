import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowRun } from '../../stores/workflow-store'
import { AutomationWorkflowFailure, AUTOMATION_NETWORK_RETRY_MS, createAutomationRetryWaiter, isAutomationNetworkFailure } from '../automation-network-retry'

function failure(status?: number, code?: string, failureCode?: string) {
  return new AutomationWorkflowFailure({ title: '写稿', uiLocale: 'zh-CN', status: 'failed', currentStepIndex: 0,
    steps: [{ name: '写稿', status: 'failed', errorCode: code, generationActivity: { operation: 'generate-draft', failureCode,
      finishReason: 'error', diagnostics: { httpStatus: status, startedAt: 0, elapsedMs: 0, phase: 'request', endReason: 'failed',
        firstResponseMs: null, lastResponseMs: null, lastOutputMs: null, visibleEvents: 0, reasoningEvents: 0 } } }],
  } as WorkflowRun, 'zh-CN')
}

describe('automation retry classification', () => {
  it.each([408, 425, 429, 500, 502, 503, 504])('retries temporary HTTP %s errors', status => {
    expect(isAutomationNetworkFailure(failure(status))).toBe(true)
  })
  it.each([400, 401, 403, 404, 413, 422])('stops for HTTP %s even with a generic network category', status => {
    expect(isAutomationNetworkFailure(failure(status, undefined, 'NETWORK_ERROR'))).toBe(false)
  })
  it.each(['GENERATION_CONTEXT_LENGTH_EXCEEDED', 'GENERATION_STORAGE_FAILED', 'ROOT_BUDGET_EXHAUSTED', 'GENERATION_SOURCE_CHANGED'])('stops for %s', code => {
    expect(isAutomationNetworkFailure(failure(undefined, code, 'NETWORK_ERROR'))).toBe(false)
  })
  it.each(['NETWORK_ERROR', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT', 'STREAM_INCOMPLETE', 'PROVIDER_STREAM_ERROR'])(
    'retries %s', code => expect(isAutomationNetworkFailure(failure(undefined, code))).toBe(true))
  it('does not turn an unknown IPC outcome, invalid format or a length limit into an endless retry', () => {
    for (const error of ['AI 未正常完成生成，结果未被保存。', 'Error invoking remote method: response lost', 'length', '模型输出格式错误']) {
      expect(isAutomationNetworkFailure(new Error(error))).toBe(false)
    }
  })
  it.each(['length', 'cancelled', 'content_filter', 'prompt_budget_exhausted'])('keeps %s terminal even with network metadata', failureCode => {
    const run = { title: '写稿', uiLocale: 'zh-CN', currentStepIndex: 0, failureCode,
      steps: [{ status: 'failed', generationActivity: { operation: 'generate-draft', failureCode: 'NETWORK_ERROR' } }],
    } as WorkflowRun
    expect(new AutomationWorkflowFailure(run, 'zh-CN').retryable).toBe(false)
  })
})

describe('cancelable 30-second retry wait', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  const setup = () => {
    const waiter = createAutomationRetryWaiter()
    const check = vi.fn()
    const update = vi.fn()
    const promise = waiter.wait({ check, update, stopped: () => new Error('stopped'), locale: 'zh-CN', error: 'NETWORK_ERROR', attempt: 4 })
    return { waiter, check, update, promise }
  }
  it('waits a full 30 seconds, updates the countdown and releases all timers', async () => {
    const f = setup()
    const finished = vi.fn()
    void f.promise.then(finished)
    expect(f.update.mock.calls[0][0]).toContain('30 秒')
    expect(f.update.mock.calls[0][0]).toContain('第 4 次')
    await vi.advanceTimersByTimeAsync(29999)
    expect(finished).not.toHaveBeenCalled()
    expect(f.update.mock.calls.at(-1)![0]).toContain('1 秒')
    await vi.advanceTimersByTimeAsync(1)
    await f.promise
    expect(AUTOMATION_NETWORK_RETRY_MS).toBe(30000)
    expect(finished).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('stops immediately when cancelled', async () => {
    const f = setup()
    const result = f.promise.catch(error => error.message)
    f.waiter.cancel()
    expect(await result).toBe('stopped')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('stops when the book session changes during the countdown', async () => {
    const f = setup()
    const result = f.promise.catch(error => error.message)
    f.check.mockImplementation(() => { throw new Error('session changed') })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toBe('session changed')
    expect(vi.getTimerCount()).toBe(0)
  })
})
