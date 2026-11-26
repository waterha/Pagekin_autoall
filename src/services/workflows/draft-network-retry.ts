import type { GenerationOutcome, GenerationSession } from '../generation/generation-harness'
import type { StepCallbacks, WorkflowContext } from '../../stores/workflow-store'
import { workflowUiText } from './workflow-project-session'
import { WorkflowCancelledError } from './workflow-cancellation'

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const
const PROSE_PURPOSES = new Set(['chapter-draft', 'chapter-draft-continuation', 'chapter-draft-no-progress-recovery', 'chapter-draft-condense'])

/** A received main-process failure receipt is required; an IPC rejection has unknown outcome. */
function emptyNetworkFailure(outcome: GenerationOutcome): boolean {
  const diagnostics = outcome.receipt.diagnostics
  return outcome.status === 'incomplete' && outcome.finishReason === 'error'
    && outcome.receipt.failureCode === 'NETWORK_ERROR' && !outcome.content.trim()
    && diagnostics?.endReason === 'failed' && diagnostics.visibleEvents === 0 && diagnostics.reasoningEvents === 0
}

function waitForRetry(milliseconds: number, signal: AbortSignal | undefined, context: WorkflowContext): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(new WorkflowCancelledError(workflowUiText(context, '工作流已取消', 'Workflow was cancelled.')))
    if (signal?.aborted || context.cancelled) { cancelled(); return }
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); cancelled() }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Retry the exact prose task within its existing session and root budget, never the whole chapter. */
export function withDraftNetworkRetry(session: GenerationSession, context: WorkflowContext, callbacks: StepCallbacks): GenerationSession {
  if (context.data?.automationNetworkRetry === true) return session
  let retries = 0
  return {
    budget: session.budget,
    async complete(task, options) {
      const frozenTask = structuredClone(task)
      let outcome = await session.complete(structuredClone(frozenTask), options)
      while (PROSE_PURPOSES.has(frozenTask.purpose) && emptyNetworkFailure(outcome) && retries < RETRY_DELAYS_MS.length
        && !context.cancelled && !options?.signal?.aborted) {
        const delay = RETRY_DELAYS_MS[retries]
        // Leave admission and accounting to the same main owner; never create a fresh budget for retries.
        if (outcome.receipt.budget.attempt >= outcome.receipt.budget.maxAttempts
          || Date.now() + delay >= session.budget.deadlineAt) break
        retries++
        callbacks.log(workflowUiText(context,
          `正文请求网络中断，${delay / 1000} 秒后自动重试（${retries}/${RETRY_DELAYS_MS.length}），沿用已有短细纲和正文进度。`,
          `The prose request lost its connection. Retrying in ${delay / 1000}s (${retries}/${RETRY_DELAYS_MS.length}), keeping the existing outline and manuscript progress.`))
        await waitForRetry(delay, options?.signal, context)
        if (context.cancelled || options?.signal?.aborted) throw new WorkflowCancelledError(workflowUiText(context, '工作流已取消', 'Workflow was cancelled.'))
        // A fresh physical request must have a fresh nonce; the main owner still validates the same frozen task.
        outcome = await session.complete(structuredClone(frozenTask), options?.invocationNonce
          ? { ...options, invocationNonce: `${options.invocationNonce}:network-retry:${retries}` } : options)
      }
      return outcome
    },
  }
}
