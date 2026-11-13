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

const commands = vi.hoisted(() => ({ write: vi.fn(), review: vi.fn(), revise: vi.fn(), finalize: vi.fn(), invoke: vi.fn(), guard: vi.fn() }))
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

function makeDraft(chapter: number) {
  const draft = { id: chapter * 10, chapterNumber: chapter, version: 1, status: 'draft', content: `第${chapter}章正文` } as Draft
  drafts.set(draft.id, draft)
  return draft
}

beforeEach(() => {
  vi.clearAllMocks()
  drafts.clear(); reviews.clear(); order.length = 0
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
    if (channel === 'db:draft-get-full') return drafts.get(Number(args[0])) ?? null
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
})
