import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AllInvokeChannels, ProjectData, ProjectSessionContext } from '../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../shared/project-session-context'
import { parseHumanConfirmedReviewSnapshot } from '../../shared/human-confirmed-review'
import { useProjectStore } from '../../stores/project-store'
import { useEditorStore } from '../../stores/editor-store'
import { useDraftStore } from '../../stores/draft-store'
import { useWorkflowStore, type WorkflowContext, type WorkflowDefinition } from '../../stores/workflow-store'
import { useLLMStore } from '../../stores/llm-store'
import { startManuscriptAutomation, stopManuscriptAutomation, useManuscriptAutomation } from '../manuscript-automation'

const commands = vi.hoisted(() => ({ write: vi.fn(), review: vi.fn(), revise: vi.fn(), finalize: vi.fn(), repair: vi.fn(), invoke: vi.fn(), guard: vi.fn() }))
vi.mock('../ipc-client', () => ({ ipc: { invokeWithProjectSession: commands.invoke } }))
vi.mock('../workflow-guards', () => ({ guardChapterWriting: commands.guard }))
vi.mock('../workflows/commands/generate-draft.command', () => ({ GenerateDraftCommand: class {
  constructor(private input: unknown) {}
  execute(params: unknown) { return commands.write(this.input, params) }
} }))
vi.mock('../workflows/commands/review-chapter.command', () => ({ ReviewChapterCommand: class {
  constructor(private input: unknown) {}
  execute(params: unknown) { return commands.review(this.input, params) }
} }))
vi.mock('../workflows/commands/refine-from-review.command', () => ({ RefineFromReviewCommand: class {
  constructor(private input: unknown) {}
  execute(params: unknown) { return commands.revise(this.input, params) }
} }))
vi.mock('../workflows/commands/finalize-chapter.command', () => ({ FinalizeChapterCommand: class {
  constructor(private input: unknown) {}
  execute(params: unknown) { return commands.finalize(this.input, params) }
}, RunFinalizePostProcessCommand: class {
  constructor(private input: unknown) {}
  execute(params: unknown) { return commands.repair(this.input, params) }
} }))

const session: ProjectSessionContext = { projectId: 'book', leaseId: 'lease', projectPath: 'C:/books/auto' }
type Draft = NonNullable<AllInvokeChannels['db:draft-get-full']['return']>
type Review = NonNullable<AllInvokeChannels['db:review-get-full']['return']>
const drafts = new Map<number, Draft>()
const reviews = new Map<number, Review>()
const order: string[] = []
let blueprintCount = 2
let pass = false
let pending = false
let recheck = false
let confirmations: string[] = []
type PostStep = { stepKey: string; label: string; ok: boolean; errorMsg?: string }
const postSteps = new Map<number, PostStep[]>()
const finalizationIds = new Map<number, string>()

function leaveFailedPostProcessing(chapter: number, error = 'FINALIZATION_GENERATION_INCOMPLETE') {
  drafts.get(chapter * 10)!.status = 'finalized'
  finalizationIds.set(chapter, `final-${chapter}`)
  postSteps.set(chapter, [
    { stepKey: 'kb_import', label: '导入知识库', ok: true },
    { stepKey: 'chapter_notes', label: '章节要点', ok: false, errorMsg: error },
    { stepKey: 'character_cards', label: '角色状态', ok: false, errorMsg: 'GENERATION_FINALIZATION_PREDECESSOR_REQUIRED' },
  ])
}

function makeDraft(chapter: number) {
  const draft = { id: chapter * 10, chapterNumber: chapter, version: 1, status: 'draft', content: `第${chapter}章正文` } as Draft
  drafts.set(draft.id, draft)
  return draft
}

beforeEach(() => {
  vi.clearAllMocks()
  drafts.clear(); reviews.clear(); order.length = 0
  postSteps.clear(); finalizationIds.clear()
  confirmations = []; blueprintCount = 2; pass = false; pending = false; recheck = false
  setActiveProjectSessionContext(session)
  useProjectStore.setState({ currentProject: { id: 'book', sessionLease: 'lease', path: session.projectPath,
    novelConfig: { wordsPerChapter: 1800 } } as ProjectData })
  useLLMStore.setState({ models: [{ id: 'writer', purposes: ['generation'] }] as never, defaultModelId: 'writer', stageModelIds: {} })
  useEditorStore.setState({ tabs: [], activeTabId: null })
  useWorkflowStore.setState({ history: [], activeRuns: [] })
  useManuscriptAutomation.setState({ active: false, stopping: false, session: null, message: '', error: false })
  commands.guard.mockResolvedValue({ ok: true })
  vi.spyOn(useDraftStore.getState(), 'loadChapterDrafts').mockResolvedValue()
  vi.spyOn(useWorkflowStore.getState(), 'startWorkflow').mockImplementation(async (definition: WorkflowDefinition) => {
    const runId = definition.runId!
    const context = { runId, projectPath: session.projectPath, projectSession: session, data: {}, cancelled: false,
      generationModelId: definition.generationModelId, uiLocale: 'zh-CN', writingLanguage: 'zh-CN' } as WorkflowContext
    let status = 'completed', error: string | undefined
    try {
      for (const step of definition.steps) await step.executor({} as never, context, {} as never)
    } catch (failure) { status = 'failed'; error = (failure as Error).message }
    useWorkflowStore.setState(state => ({ history: [{ id: runId, status, error } as never, ...state.history] }))
    return runId
  })
  commands.invoke.mockImplementation(async (_session: unknown, channel: string, ...args: unknown[]) => {
    if (channel === 'db:draft-authority-sequence') {
      let next = 1
      while (drafts.get(next * 10)?.status === 'finalized') next++
      return { status: 'valid', nextChapterNumber: next, gaps: [], duplicateChapterNumbers: [] }
    }
    if (channel === 'db:blueprint-get') return Number(args[0]) <= blueprintCount
      ? { chapterNumber: args[0], title: `标题${args[0]}`, characters: ['甲'], role: '发展', purpose: '目的', keyEvents: '事件' } : null
    if (channel === 'db:draft-list') return [...drafts.values()].filter(draft => draft.chapterNumber === args[0])
    if (channel === 'db:draft-list-all') return [...drafts.values()]
    if (channel === 'db:draft-get-finalized') return [...drafts.values()].find(draft => draft.chapterNumber === args[0] && draft.status === 'finalized') ?? null
    if (channel === 'db:draft-get-full') return drafts.get(Number(args[0])) ?? null
    if (channel === 'db:post-process-get-latest-run') {
      const chapter = Number(args[1])
      return postSteps.has(chapter) ? { id: `post-${chapter}`, triggerSourceId: `finalization:${finalizationIds.get(chapter)}` } : null
    }
    if (channel === 'db:post-process-get-steps') return postSteps.get(Number(String(args[0]).replace('post-', '')))
    if (channel === 'db:continuity-read-source') {
      const draft = drafts.get(Number(args[0]))!
      return { status: 'valid', snapshot: { content: draft.content, source: { draftId: draft.id,
        chapterNumber: draft.chapterNumber, finalizationId: finalizationIds.get(draft.chapterNumber), contentHash: 'hash' } } }
    }
    if (channel === 'db:revision-get-pending') return pending ? [{ id: 99 }] : []
    if (channel === 'db:review-get-full') return reviews.get(Number(args[0]))
    if (channel === 'db:review-cycle-get') return { cycleId: `cycle-${args[0]}`, findings: [
      { reviewItemIndex: 0, findingId: 'finding-a' }, { reviewItemIndex: 1, findingId: 'finding-b' },
    ] }
    if (channel === 'db:review-create') {
      confirmations.push((args[0] as { content: string }).content)
      return { success: true, id: 700 }
    }
    if (channel === 'db:revision-get-full') return { id: args[0], baseDraftId: Number(args[0]) - 200,
      content: `${drafts.get(Number(args[0]) - 200)!.content}修订`, status: 'pending' }
    if (channel === 'db:revision-merge') {
      const merge = args[0] as { targetDraftId: number; mergedContent: string }
      const draft = drafts.get(merge.targetDraftId)!
      order.push(`merge-${draft.chapterNumber}`)
      drafts.set(draft.id, { ...draft, status: 'revised', content: merge.mergedContent })
      return { success: true, receipt: { reviewCycle: { disposition: recheck ? 'required' : 'not-required', cycleId: 'cycle', mergedHash: 'hash' } } }
    }
    throw new Error(`Unexpected channel ${channel}`)
  })
  commands.write.mockImplementation(async (input: { chapterNumber: number }, { context }: { context: WorkflowContext }) => {
    order.push(`write-${input.chapterNumber}`)
    context.data.draftId = makeDraft(input.chapterNumber).id
  })
  commands.review.mockImplementation(async (input: { chapterNumber: number; draftPath: string; reviewCycleId?: string }, { context }: { context: WorkflowContext }) => {
    order.push(`${input.reviewCycleId ? 'recheck' : 'review'}-${input.chapterNumber}`)
    const draft = drafts.get(input.chapterNumber * 10)!
    const id = draft.id + 100
    reviews.set(id, { id, baseDraftId: draft.id, reviewIndex: 1, contentId: id, createdAt: '2026-11-13',
      sourceDraft: { id: draft.id, chapterNumber: draft.chapterNumber, version: draft.version, status: 'draft', content: draft.content },
      content: JSON.stringify({ summary: '报告', items: pass
      ? [{ severity: 'pass', category: '一致性', description: '通过' }]
      : [{ severity: 'error', category: '情节', description: '问题1', quote: '正文' }, { severity: 'warning', category: '人物', description: '问题2', quote: '正文' }] }) } as Review)
    context.data.reviewId = id
  })
  commands.revise.mockImplementation(async (input: { chapterNumber: number }, { context }: { context: WorkflowContext }) => {
    order.push(`revise-${input.chapterNumber}`)
    context.data.revisionId = input.chapterNumber * 10 + 200
  })
  commands.finalize.mockImplementation(async (input: { chapterNumber: number }) => {
    order.push(`finalize-${input.chapterNumber}`)
    drafts.get(input.chapterNumber * 10)!.status = 'finalized'
  })
  commands.repair.mockImplementation(async (input: { chapterNumber: number; stepKeys: string[] }) => {
    order.push(`repair-${input.chapterNumber}`)
    const steps = postSteps.get(input.chapterNumber)!
    for (const step of steps) if (input.stepKeys.includes(step.stepKey)) { step.ok = true; step.errorMsg = undefined }
    return { steps: Object.fromEntries(steps.map(step => [step.stepKey, { ...step, error: step.errorMsg }])) }
  })
})

afterEach(() => { vi.restoreAllMocks(); setActiveProjectSessionContext(null) })

describe('正文自动化', () => {
  it('完整处理多章：全部采纳审稿项，合并后定稿，再写下一章', async () => {
    await startManuscriptAutomation()
    expect(order).toEqual(['write-1', 'review-1', 'revise-1', 'merge-1', 'finalize-1', 'write-2', 'review-2', 'revise-2', 'merge-2', 'finalize-2'])
    const confirmation = parseHumanConfirmedReviewSnapshot(confirmations[0])!
    expect(confirmation.items.map(item => [item.decision, item.findingId])).toEqual([['apply', 'finding-a'], ['apply', 'finding-b']])
    expect(confirmation.sourceReviewId).toBe(110)
    expect(confirmation.sourceDraft?.content).toBe('第1章正文')
    expect(commands.finalize.mock.calls[0][0]).toMatchObject({ draftContent: '第1章正文修订', stopOnPostProcessFailure: true, eventSource: 'batch' })
    expect(useManuscriptAutomation.getState()).toMatchObject({ active: false, error: false, message: expect.stringContaining('已完成 2 章') })
  })

  it('无问题时直接定稿，不发起无意义的修稿', async () => {
    pass = true; blueprintCount = 1
    await startManuscriptAutomation()
    expect(order).toEqual(['write-1', 'review-1', 'finalize-1'])
    expect(parseHumanConfirmedReviewSnapshot(confirmations[0])!.items[0].decision).toBe('ignore')
  })

  it('执行合并要求的复验，完成后才能定稿', async () => {
    recheck = true; blueprintCount = 1
    await startManuscriptAutomation()
    expect(order).toEqual(['write-1', 'review-1', 'revise-1', 'merge-1', 'recheck-1', 'finalize-1'])
    expect(commands.review.mock.calls[1][0]).toMatchObject({ reviewCycleId: 'cycle', expectedMergedHash: 'hash', draftContent: '第1章正文修订' })
  })

  it('已有草稿从审稿继续，不重新写作', async () => {
    makeDraft(1); blueprintCount = 1
    await startManuscriptAutomation()
    expect(order).toEqual(['review-1', 'revise-1', 'merge-1', 'finalize-1'])
  })

  it('已有待合并稿时保留该稿并停止', async () => {
    makeDraft(1); pending = true
    await startManuscriptAutomation()
    expect(commands.review).not.toHaveBeenCalled()
    expect(useManuscriptAutomation.getState()).toMatchObject({ active: false, error: true, message: expect.stringContaining('待合并') })
  })

  it.each(['review', 'revise', 'finalize'] as const)('%s 失败时不启动后续章节', async failing => {
    commands[failing].mockRejectedValue(new Error('模拟执行失败'))
    await startManuscriptAutomation()
    expect(commands.write).toHaveBeenCalledTimes(1)
    expect(useManuscriptAutomation.getState()).toMatchObject({ active: false, error: true, message: expect.stringContaining('模拟执行失败') })
  })

  it('停止与重复点击不会启动额外运行', async () => {
    let release!: () => void
    const pendingReview = new Promise<void>(resolve => { release = resolve })
    commands.review.mockImplementationOnce(() => pendingReview)
    const cancel = vi.spyOn(useWorkflowStore.getState(), 'cancelWorkflow').mockImplementation(() => {})
    const running = startManuscriptAutomation()
    await vi.waitFor(() => expect(commands.review).toHaveBeenCalledOnce())
    await startManuscriptAutomation()
    stopManuscriptAutomation()
    release()
    await running
    expect(cancel).toHaveBeenCalledOnce()
    expect(commands.write).toHaveBeenCalledOnce()
    expect(commands.revise).not.toHaveBeenCalled()
    expect(useManuscriptAutomation.getState()).toMatchObject({ active: false, error: false, message: expect.stringContaining('已停止') })
  })

  it('同一目录重新打开得到新会话后不继续处理', async () => {
    commands.review.mockImplementationOnce(async () => { setActiveProjectSessionContext({ ...session, leaseId: 'new-lease' }) })
    await startManuscriptAutomation()
    expect(commands.revise).not.toHaveBeenCalled()
    expect(commands.write).toHaveBeenCalledOnce()
    expect(useManuscriptAutomation.getState().active).toBe(false)
  })

  it('未保存正文不会被自动写作覆盖或定稿', async () => {
    const draft = makeDraft(1)
    useEditorStore.setState({ tabs: [{ id: 'draft', type: 'chapter', projectKey: session.projectPath,
      filePath: `ai-novel://draft/${draft.id}`, content: '作者未保存内容', dirty: true }] as never })
    await startManuscriptAutomation()
    expect(order).toEqual([])
    expect(useManuscriptAutomation.getState().error).toBe(true)
    expect(useEditorStore.getState().tabs[0].content).toBe('作者未保存内容')
  })

  it('没有蓝图时给出操作提示，不调用模型', async () => {
    blueprintCount = 0
    await startManuscriptAutomation()
    expect(order).toEqual([])
    expect(useManuscriptAutomation.getState().message).toContain('请先生成章节蓝图')
  })

  it('定稿已提交但后处理失败时，自动重试失败步骤，完成后再写下一章', async () => {
    commands.finalize.mockImplementationOnce(async (input: { chapterNumber: number }) => {
      order.push(`finalize-${input.chapterNumber}`)
      leaveFailedPostProcessing(input.chapterNumber)
      throw new Error('后处理失败')
    })
    await startManuscriptAutomation()
    expect(order).toEqual(['write-1', 'review-1', 'revise-1', 'merge-1', 'finalize-1', 'repair-1',
      'write-2', 'review-2', 'revise-2', 'merge-2', 'finalize-2'])
    expect(commands.repair.mock.calls[0][0]).toMatchObject({ onlyFailed: true, retryInvalidResult: true,
      stepKeys: ['chapter_notes', 'character_cards'], draftId: 10 })
    expect(commands.finalize).toHaveBeenCalledTimes(2)
    expect(useManuscriptAutomation.getState().error).toBe(false)
  })

  it('再次开启时先修复之前已定稿章的失败后处理，再继续下一章', async () => {
    makeDraft(1); leaveFailedPostProcessing(1)
    await startManuscriptAutomation()
    expect(order[0]).toBe('repair-1')
    expect(order[1]).toBe('write-2')
    expect(commands.finalize).toHaveBeenCalledOnce()
  })

  it('连续失败最多自动重试3轮，保留正文且不写下一章', async () => {
    makeDraft(1); leaveFailedPostProcessing(1)
    commands.repair.mockImplementation(async () => {
      order.push('repair-1')
      return { steps: Object.fromEntries(postSteps.get(1)!.map(step => [step.stepKey, { ...step, error: step.errorMsg }])) }
    })
    await startManuscriptAutomation()
    expect(commands.repair).toHaveBeenCalledTimes(3)
    expect(commands.write).not.toHaveBeenCalled()
    expect(drafts.get(10)!.status).toBe('finalized')
    expect(useManuscriptAutomation.getState()).toMatchObject({ active: false, error: true, message: expect.stringContaining('重试 3 轮') })
  })

  it('第二轮恢复成功后自动继续', async () => {
    makeDraft(1); leaveFailedPostProcessing(1)
    commands.repair.mockImplementationOnce(async () => { throw new Error('连接中断') })
    await startManuscriptAutomation()
    expect(commands.repair).toHaveBeenCalledTimes(2)
    expect(commands.write.mock.calls[0][0].chapterNumber).toBe(2)
  })

  it('非关键角色步骤失败也会重试，不提前继续写作', async () => {
    makeDraft(1); leaveFailedPostProcessing(1)
    postSteps.get(1)![1].ok = true
    postSteps.get(1)![2].errorMsg = 'FINALIZATION_GENERATION_INCOMPLETE'
    await startManuscriptAutomation()
    expect(commands.repair.mock.calls[0][0].stepKeys).toEqual(['character_cards'])
    expect(order.slice(0, 2)).toEqual(['repair-1', 'write-2'])
  })

  it('后处理状态读取失败时不启动模型调用', async () => {
    makeDraft(1); leaveFailedPostProcessing(1)
    const original = commands.invoke.getMockImplementation()!
    commands.invoke.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === 'db:post-process-get-steps') throw new Error('读取失败')
      return original(...args)
    })
    await startManuscriptAutomation()
    expect(commands.repair).not.toHaveBeenCalled()
    expect(commands.write).not.toHaveBeenCalled()
    expect(useManuscriptAutomation.getState().message).toContain('读取失败')
  })

  it('不能重试的失败与旧版本步骤不会无限重跑', async () => {
    makeDraft(1); leaveFailedPostProcessing(1, 'GENERATION_STORAGE_FAILED')
    await startManuscriptAutomation()
    expect(commands.repair).not.toHaveBeenCalled()
    expect(commands.write).not.toHaveBeenCalled()
    expect(useManuscriptAutomation.getState().message).toContain('无法自动重试')
    postSteps.set(1, [{ stepKey: 'style_analysis', label: '旧步骤', ok: false }])
    await startManuscriptAutomation()
    expect(commands.write.mock.calls[0][0].chapterNumber).toBe(2)
  })

  it('重试期间停止会取消对应任务并且不继续下一章', async () => {
    makeDraft(1); leaveFailedPostProcessing(1)
    let release!: () => void
    commands.repair.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ steps: {} }) }))
    const cancel = vi.spyOn(useWorkflowStore.getState(), 'cancelWorkflow').mockImplementation(() => {})
    const running = startManuscriptAutomation()
    await vi.waitFor(() => expect(commands.repair).toHaveBeenCalledOnce())
    stopManuscriptAutomation(); release(); await running
    expect(cancel).toHaveBeenCalledOnce()
    expect(commands.write).not.toHaveBeenCalled()
    expect(useManuscriptAutomation.getState()).toMatchObject({ active: false, error: false })
  })

  it('重试时同一目录重新打开新会话就停止', async () => {
    makeDraft(1); leaveFailedPostProcessing(1)
    commands.repair.mockImplementationOnce(async () => { setActiveProjectSessionContext({ ...session, leaseId: 'new' }); return { steps: {} } })
    await startManuscriptAutomation()
    expect(commands.repair).toHaveBeenCalledOnce()
    expect(commands.write).not.toHaveBeenCalled()
    expect(useManuscriptAutomation.getState()).toMatchObject({ active: false, error: false })
  })

  it('定稿来源被替换后不继续重试或写下一章', async () => {
    makeDraft(1); leaveFailedPostProcessing(1)
    commands.repair.mockImplementationOnce(async () => { finalizationIds.set(1, 'replacement'); return { steps: {} } })
    await startManuscriptAutomation()
    expect(commands.repair).toHaveBeenCalledOnce()
    expect(commands.write).not.toHaveBeenCalled()
    expect(useManuscriptAutomation.getState().message).toContain('来源已变化')
  })
})
