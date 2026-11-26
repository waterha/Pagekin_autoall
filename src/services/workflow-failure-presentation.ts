import { knownAppErrorMessage } from '../i18n/app-errors'
import { classifyGenerationFailure } from './generation/prompt-budget-failure'
import type { Locale } from '../i18n/types'
import type { PromptBudgetReport } from './generation/generation-harness'
import type { WorkflowFailureCode, WorkflowRun, WorkflowStep } from '../stores/workflow-store'

export interface WorkflowFailurePresentation {
  heading: string
  reason: string
  persistence?: string
  guidance?: string
  action?: 'open-novel-config'
  actionLabel?: string
  details?: string[]
}

/** Only normalized metadata crosses this boundary; never display provider bodies or request URLs. */
function diagnosticReason(activity: WorkflowStep['generationActivity'], locale: Locale): string | undefined {
  if (!activity) return undefined
  const zh = locale === 'zh-CN'
  if (activity.failureCode === 'GENERATION_CONTEXT_LENGTH_EXCEEDED') return knownAppErrorMessage(locale, activity.failureCode)
  if (activity.failureCode === 'GENERATION_STORAGE_FAILED') return zh ? '生成结果保存失败。请检查磁盘空间及文件是否被占用。' : 'Saving the generated result failed. Check disk space and whether files are in use.'
  if (activity.failureCode === 'ROOT_BUDGET_EXHAUSTED') return knownAppErrorMessage(locale, activity.failureCode)
  const d = activity.diagnostics
  if (d?.endReason !== 'failed' && !activity.failureCode && activity.finishReason !== 'error') return undefined
  const code = d?.causeCode ?? d?.errorCode
  if (code === 'UND_ERR_BODY_TIMEOUT') return zh ? '读取响应流超时。上游为何停止响应尚未确认。' : 'Reading the response stream timed out. Why the upstream stopped responding is not confirmed.'
  if (['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].includes(code ?? '')) return zh ? '等待服务响应超时。具体原因尚未确认。' : 'Waiting for the service timed out. The underlying cause is not confirmed.'
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code ?? '')) return zh ? '无法解析模型服务地址（DNS 错误）。请检查网络和服务地址。' : 'The model service address could not be resolved (DNS error). Check the network and service address.'
  if (code === 'ECONNREFUSED') return zh ? '模型服务拒绝连接。请检查服务是否可用及地址、端口是否正确。' : 'The model service refused the connection. Check service availability, address and port.'
  if (['UND_ERR_SOCKET', 'ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(code ?? '')) return zh ? '响应连接中断。具体原因尚未确认。' : 'The response connection was interrupted. The underlying cause is not confirmed.'
  if (code === 'STREAM_INCOMPLETE') return zh ? '响应流在完整结果返回前结束。具体原因尚未确认。' : 'The response stream ended before a complete result arrived. The underlying cause is not confirmed.'
  if (code === 'STREAM_INVALID' || code === 'RESPONSE_BODY_MISSING') return zh ? '服务响应缺少有效的生成数据。' : 'The service response did not contain valid generation data.'
  if (d?.httpStatus && d.httpStatus >= 400) {
    const explanation = d.httpStatus === 401 ? (zh ? '身份验证失败，请检查 API Key。' : 'Authentication failed. Check the API key.')
      : d.httpStatus === 403 ? (zh ? '请求被拒绝，请检查账号和模型访问权限。' : 'Access was denied. Check account and model permissions.')
      : d.httpStatus === 429 ? (zh ? '服务限制了请求，请检查调用频率、配额或余额。' : 'The service limited the request. Check request rate, quota or balance.')
      : d.httpStatus >= 500 ? (zh ? '模型服务或中转服务发生错误，请稍后重试。' : 'The model service or gateway failed. Try again later.')
      : (zh ? '请求被服务拒绝，请检查模型和请求配置。' : 'The service rejected the request. Check the model and request settings.')
    return `HTTP ${d.httpStatus}：${explanation}`
  }
  if (code === 'PROVIDER_STREAM_ERROR') return zh ? '模型服务在响应流中报告生成失败，未提供可安全展示的具体原因。' : 'The model service reported a generation failure in the response stream without a safe specific cause.'
  if (activity.failureCode === 'NETWORK_ERROR') return zh ? '网络请求失败，未收到更具体的网络错误码。请检查网络和模型服务连接。' : 'The network request failed without a more specific network code. Check the network and model service connection.'
  return zh ? '模型请求未完成，具体原因未知；服务未提供可安全展示的进一步说明。' : 'The model request did not complete; the specific cause is unknown. The service supplied no further safe explanation.'
}

function diagnosticDetails(activity: WorkflowStep['generationActivity'], locale: Locale): string[] | undefined {
  if (!activity) return undefined
  const zh = locale === 'zh-CN'
  const d = activity.diagnostics
  const codes = [activity.failureCode, d?.errorCode, d?.causeCode].filter((code): code is string => Boolean(code))
  const details: string[] = []
  if (codes.length) details.push(`${zh ? '诊断码：' : 'Diagnostic codes: '}${[...new Set(codes)].join(' / ')}`)
  if (activity.finishReason) details.push(`${zh ? '模型结束原因：' : 'Model finish reason: '}${activity.finishReason}`)
  if (d) {
    const phases = { request: zh ? '建立请求' : 'request', response: zh ? '接收响应' : 'response', stream: zh ? '读取响应流' : 'stream', complete: zh ? '响应结束' : 'complete' }
    details.push(`${zh ? '请求情况：' : 'Request: '}${phases[d.phase]}${d.httpStatus ? ` · HTTP ${d.httpStatus}` : ''} · ${zh ? '耗时 ' : ''}${Math.round(d.elapsedMs / 1000)} ${zh ? '秒' : 's'}`)
    if (d.visibleEvents === 0) details.push(d.reasoningEvents > 0
      ? (zh ? '只收到推理内容，没有收到可见正文。' : 'Only reasoning was received; no visible text arrived.')
      : (zh ? '没有收到可见正文。' : 'No visible text arrived.'))
  }
  return details.length ? details : undefined
}

const NOVEL_CONFIG_SECTIONS = new Set([
  'global-guidance',
  'reference-works',
  'genre',
  'protagonist-profile',
  'project-chapter-count',
])

const INTERNAL_OVERHEAD_SECTIONS = new Set(['system-instructions', 'prompt-overhead'])

function primaryProtectedSection(report: PromptBudgetReport | undefined): string | undefined {
  return report?.sections
    .filter(section => !INTERNAL_OVERHEAD_SECTIONS.has(section.sectionName))
    .sort((left, right) => right.utf8Bytes - left.utf8Bytes)[0]?.sectionName
}

function promptBudgetAdjustment(
  report: PromptBudgetReport | undefined,
  locale: Locale,
): Pick<WorkflowFailurePresentation, 'guidance' | 'action' | 'actionLabel'> {
  const sectionName = primaryProtectedSection(report)
  if (sectionName && NOVEL_CONFIG_SECTIONS.has(sectionName)) {
    return locale === 'zh-CN'
      ? {
          guidance: '请在小说配置中缩短列出的项目配置字段后重试。',
          action: 'open-novel-config',
          actionLabel: '打开小说配置',
        }
      : {
          guidance: 'Shorten the listed project configuration fields in Novel configuration, then try again.',
          action: 'open-novel-config',
          actionLabel: 'Open novel configuration',
        }
  }

  if (sectionName === 'step-guidance') {
    return {
      guidance: locale === 'zh-CN'
        ? '请返回该生成步骤，缩短步骤指导后重试。'
        : 'Return to that generation step, shorten its step guidance, and try again.',
    }
  }
  if (sectionName === 'knowledge-base') {
    return {
      guidance: locale === 'zh-CN'
        ? '请减少本次使用的知识库内容或缩小检索范围后重试。'
        : 'Reduce the knowledge-base content used for this request or narrow the retrieval scope, then try again.',
    }
  }
  if (sectionName === 'validated-prefix' || sectionName === 'batch-slot-ids') {
    return {
      guidance: locale === 'zh-CN'
        ? '请减小本次结构化批次后重试；已验证内容不会被静默截断。'
        : 'Reduce this structured batch and try again; validated content will not be silently truncated.',
    }
  }
  if (sectionName === 'repair-candidate') {
    return {
      guidance: locale === 'zh-CN'
        ? '请缩短待修复的结构化内容，或将本次导入或生成拆成更小批次后重试。'
        : 'Shorten the structured content being repaired, or split this import or generation into smaller batches, then try again.',
    }
  }
  if (sectionName === 'repair-contract') {
    return {
      guidance: locale === 'zh-CN'
        ? '结构化修复合同不能在界面中安全编辑。请缩小本次任务范围；若问题持续，请记录结果码并反馈。'
        : 'The structured repair contract cannot be safely edited in the interface. Reduce this task scope; if the problem persists, report the result code.',
    }
  }
  if (
    sectionName === 'architecture'
    || sectionName === 'story-premise'
    || sectionName === 'identity-manifest'
    || sectionName === 'previous-blueprints'
    || sectionName === 'target-chapter'
  ) {
    return {
      guidance: locale === 'zh-CN'
        ? '请缩短相关故事架构内容，或缩小本次生成范围后重试。'
        : 'Shorten the related story-architecture content or reduce this generation scope, then try again.',
    }
  }
  return {
    guidance: locale === 'zh-CN'
      ? '请缩小本次生成范围后重试；若问题持续，请记录结果码并反馈。'
      : 'Reduce this generation scope and try again; if the problem persists, report the result code.',
  }
}

export function presentWorkflowFailure(
  failureCode: WorkflowFailureCode | undefined,
  error: string | undefined,
  locale: Locale,
  isUnpersistedChapterDraft: boolean,
  promptBudgetReport?: PromptBudgetReport,
  activity?: WorkflowStep['generationActivity'],
): WorkflowFailurePresentation {
  if (failureCode === 'prompt_budget_exhausted') {
    const adjustment = promptBudgetAdjustment(promptBudgetReport, locale)
    return locale === 'zh-CN'
      ? {
          heading: '提示词预算不足',
          reason: error?.trim() || '受保护的结构化请求超过了安全字节上限。',
          persistence: '本次被预算预检阻止的请求未发送，未产生额外模型尝试或消费。',
          ...adjustment,
        }
      : {
          heading: 'Prompt budget is insufficient',
          reason: error?.trim() || 'The protected structured request exceeded its safe byte limit.',
          persistence: 'The request blocked by this budget preflight was not sent and caused no additional model attempt or consumption.',
          ...adjustment,
        }
  }

  if (activity?.operation === 'review-chapter') {
    const diagnostic = activity.diagnostics
    const reason = (classifyGenerationFailure(error, null) !== 'provider-context' ? diagnosticReason(activity, locale) : undefined)
      ?? knownAppErrorMessage(locale, error) ?? (error?.trim() || (locale === 'zh-CN' ? '审稿未完成，原因未知。' : 'The review did not finish; the cause is unknown.'))
    return {
      heading: locale === 'zh-CN' ? '审稿未完成' : 'Review did not finish',
      reason,
      details: diagnosticDetails(activity, locale),
      persistence: diagnostic?.endReason === 'failed'
        ? (locale === 'zh-CN' ? '本次未保存完整审稿报告，原稿保留。' : 'No complete review report was saved; the source draft is preserved.')
        : (locale === 'zh-CN' ? '尚未确认完整审稿报告已保存；原稿保留。' : 'A saved complete review report has not been confirmed; the source draft is preserved.'),
      guidance: locale === 'zh-CN' ? '请查看恢复入口。已有保存结果可直接打开；重新审稿会重新调用模型。' : 'Check recovery actions. Saved results open directly; reviewing again sends a new model request.',
    }
  }

  if (failureCode === 'content_filter') {
    return locale === 'zh-CN'
      ? {
          heading: '正文生成被内容策略拦截',
          reason: '模型的内容安全策略拦截了这次输出。',
          persistence: '本次未保存草稿或正文章节。请调整章节要求，或选择符合预期内容政策的模型后重试。',
        }
      : {
          heading: 'Draft generation was blocked by the content policy',
          reason: 'The model safety policy filtered this output.',
          persistence: 'No draft or manuscript chapter was saved. Adjust the chapter request, or choose a model whose policy fits your intended permitted content, then try again.',
        }
  }

  const specificReason = classifyGenerationFailure(error, null) !== 'provider-context' && failureCode !== 'length'
    ? diagnosticReason(activity, locale) : undefined
  const details = diagnosticDetails(activity, locale)
  const fallback = (failureCode === 'error' || failureCode === 'unknown') && (!error?.trim() || /^(AI 未正常完成生成，结果未被保存。|AI generation did not complete normally, so the result was not saved\.)$/.test(error.trim()))
    ? (locale === 'zh-CN' ? '生成未完成；没有收到可定位原因的诊断信息，请查看模型服务状态或重试。' : 'Generation did not complete. No diagnostic information identifying the cause was received; check the model service or try again.')
    : undefined
  return locale === 'zh-CN'
    ? {
        heading: '工作流未完成',
        reason: specificReason ?? fallback ?? knownAppErrorMessage(locale, error) ?? (error?.trim() || '生成在完成前停止。'),
        ...(details ? { details } : {}),
        persistence: isUnpersistedChapterDraft
          ? '本次未保存草稿或正文章节。'
          : undefined,
      }
    : {
        heading: 'Workflow did not finish',
        reason: specificReason ?? fallback ?? knownAppErrorMessage(locale, error) ?? (error?.trim() || 'Generation stopped before it completed.'),
        ...(details ? { details } : {}),
        persistence: isUnpersistedChapterDraft
          ? 'This attempt did not save a draft or manuscript chapter.'
          : undefined,
      }
}

export function workflowRunFailurePresentation(run: WorkflowRun, locale = run.uiLocale): WorkflowFailurePresentation {
  const step = run.steps?.find(item => item.status === 'failed') ?? run.steps?.[run.currentStepIndex] ?? run.steps?.[0]
  return presentWorkflowFailure(run.failureCode ?? step?.failureCode, run.error || step?.error, locale,
    run.type === 'chapter_creation' && run.chapterWordsTarget !== undefined && !step?.result?.trim(),
    run.promptBudgetReport ?? step?.promptBudgetReport, step?.generationActivity)
}

/** The exact run's failure survives automation wrappers instead of being reduced to run.error. */
export function workflowFailureMessage(run: WorkflowRun, locale: Locale): string {
  const step = run.steps?.find(item => item.status === 'failed') ?? run.steps?.[run.currentStepIndex]
  const presentation = workflowRunFailurePresentation(run, locale)
  const code = run.errorCode ?? step?.errorCode
  const location = [run.title, step?.name].filter(Boolean).join(' · ')
  return [
    location ? `${locale === 'zh-CN' ? '失败环节：' : 'Failed step: '}${location}` : undefined,
    presentation.reason,
    code ? `${locale === 'zh-CN' ? '错误码：' : 'Error code: '}${code}` : undefined,
    ...(presentation.details ?? []),
  ].filter(Boolean).join('\n')
}
