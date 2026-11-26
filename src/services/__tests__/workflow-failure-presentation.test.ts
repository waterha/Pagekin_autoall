import { describe, expect, it } from 'vitest'
import { displayedErrorMessage } from '../../i18n/app-errors'
import type { WorkflowRun, WorkflowStep } from '../../stores/workflow-store'
import { presentWorkflowFailure, workflowFailureMessage, workflowRunFailurePresentation } from '../workflow-failure-presentation'

const activity = (patch: Partial<NonNullable<WorkflowStep['generationActivity']>['diagnostics']> = {}): NonNullable<WorkflowStep['generationActivity']> => ({
  operation: 'generate-draft', finishReason: 'error', failureCode: 'NETWORK_ERROR',
  diagnostics: { startedAt: 0, elapsedMs: 12500, firstResponseMs: null, lastResponseMs: null, lastOutputMs: null,
    phase: 'request', endReason: 'failed', visibleEvents: 0, reasoningEvents: 0, ...patch },
})
const failedRun = (generationActivity = activity({ causeCode: 'ECONNRESET' })): WorkflowRun => ({
  title: '第 34 章 · 写稿', uiLocale: 'zh-CN', type: 'chapter_creation', chapterWordsTarget: 1800,
  currentStepIndex: 1, error: 'AI 未正常完成生成，结果未被保存。', failureCode: 'error',
  steps: [
    { name: '写稿', status: 'failed', generationActivity },
    { name: '尚未运行', status: 'pending' },
  ],
}) as WorkflowRun

describe('automation failure details', () => {
  it.each(['generate-draft', 'generate-blueprints', 'generate-architecture', 'review-chapter', 'refine-from-review'])(
    'explains network failures in %s and keeps the code, time and output state', operation => {
      const run = failedRun({ ...activity({ causeCode: 'ECONNRESET', phase: 'stream' }), operation })
      const message = workflowFailureMessage(run, 'zh-CN')
      expect(message).toContain('失败环节：第 34 章 · 写稿 · 写稿')
      expect(message).toContain('响应连接中断')
      expect(message).toContain('NETWORK_ERROR / ECONNRESET')
      expect(message).toContain('模型结束原因：error')
      expect(message).toContain('读取响应流 · 耗时 13 秒')
      expect(message).toContain('没有收到可见正文')
      // The automation's catch must not translate the whole detailed message back into a generic error.
      expect(displayedErrorMessage('zh-CN', new Error(message))).toBe(message)
    },
  )

  it.each([
    [401, '身份验证失败'], [403, '访问权限'], [429, '配额或余额'], [503, '中转服务发生错误'],
  ])('explains HTTP %s without claiming one unconfirmed upstream cause', (httpStatus, reason) => {
    const presentation = workflowRunFailurePresentation(failedRun(activity({ httpStatus, errorCode: 'HTTP_ERROR' })))
    expect(presentation.reason).toContain(`HTTP ${httpStatus}`)
    expect(presentation.reason).toContain(reason)
  })

  it.each([
    ['UND_ERR_BODY_TIMEOUT', '读取响应流超时'], ['UND_ERR_CONNECT_TIMEOUT', '等待服务响应超时'],
    ['ENOTFOUND', 'DNS'], ['EAI_AGAIN', 'DNS'], ['ECONNREFUSED', '拒绝连接'],
    ['STREAM_INCOMPLETE', '完整结果返回前结束'], ['STREAM_INVALID', '缺少有效的生成数据'],
  ])('explains the normalized diagnostic %s', (causeCode, reason) => {
    expect(workflowRunFailurePresentation(failedRun(activity({ causeCode }))).reason).toContain(reason)
  })

  it('preserves a context-window failure instead of attributing every HTTP 400 to configuration', () => {
    const run = failedRun({ ...activity({ httpStatus: 400 }), failureCode: 'GENERATION_CONTEXT_LENGTH_EXCEEDED' })
    expect(workflowRunFailurePresentation(run).reason).toBe(knownContextReason())
  })

  it('shows reasoning-only output and explicitly reports unknown causes', () => {
    const run = failedRun({ ...activity({ reasoningEvents: 12 }), failureCode: 'GENERATION_PROVIDER_FAILED' })
    const message = workflowFailureMessage(run, 'zh-CN')
    expect(message).toContain('具体原因未知')
    expect(message).toContain('只收到推理内容')
  })

  it('explains missing diagnostics on old generic failures and preserves specific application errors', () => {
    expect(presentWorkflowFailure('error', 'AI 未正常完成生成，结果未被保存。', 'zh-CN', true).reason).toContain('没有收到可定位原因')
    expect(presentWorkflowFailure('error', '保存失败：磁盘空间不足', 'zh-CN', false).reason).toBe('保存失败：磁盘空间不足')
  })

  it('uses English for English automation messages and never reads raw provider payloads', () => {
    const extra = { ...activity({ httpStatus: 429, errorCode: 'HTTP_ERROR' }),
      providerBody: 'secret-key https://private-endpoint.example', requestHeaders: { Authorization: 'secret-key' } }
    const message = workflowFailureMessage(failedRun(extra), 'en-US')
    expect(message).toContain('Failed step:')
    expect(message).toContain('quota or balance')
    expect(message).not.toContain('secret-key')
    expect(message).not.toContain('private-endpoint')
    expect(message.split('\n').slice(1).join('\n')).not.toMatch(/[\u4e00-\u9fff]/u)
  })
})

function knownContextReason() {
  return displayedErrorMessage('zh-CN', 'GENERATION_CONTEXT_LENGTH_EXCEEDED')
}
