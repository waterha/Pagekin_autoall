import { displayedErrorMessage } from '../i18n/app-errors'
import { localize, type Locale } from '../i18n/core'
import type { WorkflowRun } from '../stores/workflow-store'
import { workflowFailureMessage } from './workflow-failure-presentation'

export const AUTOMATION_NETWORK_RETRY_MS = 30_000
const NETWORK_CODES = new Set(['NETWORK_ERROR', 'LLM_STREAM_NETWORK_FAILED', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'ERR_STREAM_PREMATURE_CLOSE', 'STREAM_INCOMPLETE', 'PROVIDER_STREAM_ERROR'])
const BLOCKING_CODES = /GENERATION_(?:CONTEXT_LENGTH_EXCEEDED|STORAGE_FAILED|SOURCE_CHANGED|MODEL_CHANGED)|ROOT_BUDGET_EXHAUSTED|content_filter/
const BLOCKING_TERMINALS = new Set(['length', 'cancelled', 'content_filter', 'prompt_budget_exhausted'])

/** Keep the received run's evidence across the automation's error boundary. */
export class AutomationWorkflowFailure extends Error {
  readonly retryable: boolean
  readonly blocked: boolean
  constructor(run: WorkflowRun, locale: Locale) {
    super(workflowFailureMessage(run, locale))
    const step = run.steps?.find(item => item.status === 'failed') ?? run.steps?.[run.currentStepIndex]
    const activity = step?.generationActivity
    const code = run.errorCode ?? step?.errorCode
    const status = activity?.diagnostics?.httpStatus
    const blocked = [code, activity?.failureCode, run.failureCode, step?.failureCode, activity?.finishReason].some(value => value && (BLOCKING_CODES.test(value) || BLOCKING_TERMINALS.has(value)))
      || status !== undefined && status >= 400 && status < 500 && ![408, 425, 429].includes(status)
    this.blocked = blocked
    this.retryable = !blocked && (
      status !== undefined && ([408, 425, 429].includes(status) || status >= 500 && status <= 599)
      || [code, activity?.failureCode, activity?.diagnostics?.causeCode, activity?.diagnostics?.errorCode].some(value => value && NETWORK_CODES.has(value))
      || activity?.failureCode === 'GENERATION_PROVIDER_FAILED'
      || isAutomationNetworkFailure(run.error ?? step?.error)
    )
  }
}

/** Legacy errors retain stable codes; never guess that a source conflict or unknown IPC outcome is retryable. */
export function isAutomationNetworkFailure(error: unknown): boolean {
  if (error instanceof AutomationWorkflowFailure) return error.retryable
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (BLOCKING_CODES.test(message)) return false
  return [...NETWORK_CODES].some(code => new RegExp(`\\b${code}\\b`).test(message))
    || /\b(?:GENERATION_PROVIDER_FAILED|FINALIZATION_GENERATION_INCOMPLETE)\b/.test(message)
    || /^(?:网络中断|网络连接中断|连接模型服务超时)$/.test(message)
}

/** One cancelable wait per automation; session checks keep a reopened book from inheriting a retry. */
export function createAutomationRetryWaiter() {
  let cancel: (() => void) | undefined
  return {
    cancel() { cancel?.() },
    wait(options: { check: () => void; stopped: () => Error; locale: Locale; error: unknown; attempt: number; update: (message: string) => void }): Promise<void> {
      options.check()
      const detail = displayedErrorMessage(options.locale, options.error)
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + AUTOMATION_NETWORK_RETRY_MS
        const cleanup = () => { clearInterval(tick); clearTimeout(timer); cancel = undefined }
        const stop = () => { cleanup(); reject(options.stopped()) }
        const refresh = () => {
          try {
            options.check()
            const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
            options.update(localize(options.locale,
              `连接或模型服务暂时失败，${remaining} 秒后自动重试（第 ${options.attempt} 次），可点击停止。\n${detail}`,
              `Connection or model service temporarily failed. Retrying in ${remaining}s (retry ${options.attempt}); you can stop at any time.\n${detail}`))
          } catch (error) { cleanup(); reject(error) }
        }
        const tick = setInterval(refresh, 1000)
        const timer = setTimeout(() => {
          cleanup()
          try { options.check(); resolve() } catch (error) { reject(error) }
        }, AUTOMATION_NETWORK_RETRY_MS)
        cancel = stop
        refresh()
      })
    },
  }
}
