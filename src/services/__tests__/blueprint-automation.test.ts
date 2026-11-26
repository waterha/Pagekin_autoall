import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectData, ProjectSessionContext } from '../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../shared/project-session-context'
import { useProjectStore } from '../../stores/project-store'
import { useEditorStore } from '../../stores/editor-store'
import { useLLMStore } from '../../stores/llm-store'
import { useWorkflowStore, type WorkflowContext, type WorkflowDefinition } from '../../stores/workflow-store'
import { startBlueprintAutomation, stopBlueprintAutomation, useBlueprintAutomation } from '../blueprint-automation'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), config: vi.fn(), guard: vi.fn(), generate: vi.fn() }))
vi.mock('../ipc-client', () => ({ ipc: { invokeWithProjectSession: mocks.invoke, invoke: mocks.config } }))
vi.mock('../workflow-guards', () => ({ guardDirectoryGeneration: mocks.guard }))
vi.mock('../workflows/commands/directory.command', () => ({
  GenerateDirectoryCommand: class {
    constructor(private params: unknown, private snapshot: unknown) {}
    execute(input: unknown) { return mocks.generate(this.params, this.snapshot, input) }
  },
  DirectoryPartialCommitError: class extends Error {},
  DirectoryPostCommitSyncError: class extends Error {},
  DirectoryPostCommitCancellationError: class extends Error {},
  DirectoryCostLimitError: class extends Error {},
}))

const session: ProjectSessionContext = { projectId: 'book', leaseId: 'lease', projectPath: 'C:/books/auto' }
const planned = new Set<number>()
let next = 1
let pendingSync = false

beforeEach(() => {
  vi.resetAllMocks()
  planned.clear(); next = 1; pendingSync = false
  setActiveProjectSessionContext(session)
  useProjectStore.setState({ currentProject: { id: 'book', sessionLease: 'lease', path: session.projectPath,
    novelConfig: { totalChapters: 12, wordsPerChapter: 1800 } } as ProjectData })
  useEditorStore.setState({ tabs: [], draftLedgers: {} })
  useLLMStore.setState({ models: [{ id: 'planner', purposes: ['generation'] }] as never, defaultModelId: 'planner', stageModelIds: {} })
  useWorkflowStore.setState({ history: [], activeRuns: [] })
  useBlueprintAutomation.setState({ session: null, active: false, stopping: false, message: '', error: false, startChapter: null, endChapter: null })
  mocks.guard.mockResolvedValue({ ok: true })
  mocks.config.mockResolvedValue({ blueprintTargetUnits: 700 })
  mocks.invoke.mockImplementation(async (_session: unknown, channel: string) => {
    if (channel === 'db:draft-authority-sequence') return { status: 'valid', nextChapterNumber: next, gaps: [], duplicateChapterNumbers: [] }
    if (channel === 'db:blueprint-get-all') return [...planned].map(chapterNumber => ({ chapterNumber, title: `原有${chapterNumber}` }))
    if (channel === 'db:blueprint-character-sync-list-pending') return pendingSync ? [{ operationId: 'pending' }] : []
    if (channel === 'db:project-core-get') return { premise: '前提'.repeat(30) }
    throw new Error(`Unexpected channel: ${channel}`)
  })
  mocks.generate.mockImplementation(async ({ startChapter, count }: { startChapter: number; count: number }) => {
    for (let chapter = startChapter; chapter < startChapter + count; chapter++) planned.add(chapter)
    return []
  })
  vi.spyOn(useWorkflowStore.getState(), 'startWorkflow').mockImplementation(async (definition: WorkflowDefinition) => {
    const context = { runId: definition.runId, projectPath: session.projectPath, projectSession: session,
      data: {}, cancelled: false, generationModelId: definition.generationModelId, uiLocale: 'zh-CN' } as WorkflowContext
    let status = 'completed', error: string | undefined
    try {
      for (const step of definition.steps) await step.executor({} as never, context, { log: vi.fn() } as never)
    } catch (failure) { status = 'failed'; error = (failure as Error).message }
    useWorkflowStore.setState(state => ({ history: [{ id: definition.runId, status, error } as never, ...state.history] }))
    return definition.runId!
  })
})
afterEach(() => { vi.restoreAllMocks(); setActiveProjectSessionContext(null) })

describe('蓝图自动化', () => {
  it('沿用真实蓝图工作流，按5章连续规划，最后一批不超过总章数', async () => {
    await startBlueprintAutomation()
    expect(mocks.generate.mock.calls.map(call => call[0])).toEqual([
      { mode: 'append', startChapter: 1, count: 5, targetUnits: 700 },
      { mode: 'append', startChapter: 6, count: 5, targetUnits: 700 },
      { mode: 'append', startChapter: 11, count: 2, targetUnits: 700 },
    ])
    expect(mocks.generate.mock.calls[1][2].context.data.existingBlueprints).toHaveLength(5)
    expect(useWorkflowStore.getState().startWorkflow).toHaveBeenCalledWith(expect.objectContaining({ generationModelId: 'planner', type: 'directory' }), false)
    expect(planned.size).toBe(12)
    expect(useBlueprintAutomation.getState()).toMatchObject({ active: false, error: false, message: expect.stringContaining('本次新增 12 章') })
  })

  it('从已有规划之后续接，已定稿的范围不重新规划', async () => {
    next = 4
    planned.add(4); planned.add(5)
    await startBlueprintAutomation()
    expect(mocks.generate.mock.calls.map(call => [call[0].startChapter, call[0].count])).toEqual([[6, 5], [11, 2]])
    expect(planned.has(1)).toBe(false)
  })

  it('填补缺少的蓝图，在已有章前缩短批次以免覆盖', async () => {
    planned.add(3); planned.add(8)
    await startBlueprintAutomation()
    expect(mocks.generate.mock.calls.map(call => [call[0].startChapter, call[0].count])).toEqual([[1, 2], [4, 4], [9, 4]])
  })

  it('全部已规划时直接结束，无需模型也不产生调用', async () => {
    for (let chapter = 1; chapter <= 12; chapter++) planned.add(chapter)
    useLLMStore.setState({ models: [], defaultModelId: undefined })
    await startBlueprintAutomation()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.config).not.toHaveBeenCalled()
    expect(useBlueprintAutomation.getState().error).toBe(false)
  })

  it('失败时保留已完成批次，再次开启接着规划', async () => {
    mocks.generate.mockImplementationOnce(async () => {
      for (let chapter = 1; chapter <= 5; chapter++) planned.add(chapter)
      return []
    }).mockRejectedValueOnce(new Error('模型失败'))
    await startBlueprintAutomation()
    expect(mocks.generate).toHaveBeenCalledTimes(2)
    expect(planned.size).toBe(5)
    expect(useBlueprintAutomation.getState().error).toBe(true)
    await startBlueprintAutomation()
    expect(mocks.generate.mock.calls[2][0].startChapter).toBe(6)
    expect(planned.size).toBe(12)
  })

  it('失败提示保留服务 HTTP 状态和失败环节', async () => {
    vi.mocked(useWorkflowStore.getState().startWorkflow).mockImplementationOnce(async definition => {
      useWorkflowStore.setState({ history: [{ id: definition.runId, title: definition.title, status: 'failed', currentStepIndex: 0,
        error: 'AI 未正常完成生成，结果未被保存。', steps: [{ name: '生成蓝图', status: 'failed', generationActivity: {
          operation: 'generate-blueprints', diagnostics: { startedAt: 0, elapsedMs: 1000, firstResponseMs: null,
            lastResponseMs: null, lastOutputMs: null, httpStatus: 429, phase: 'response', endReason: 'failed',
            errorCode: 'HTTP_ERROR', visibleEvents: 0, reasoningEvents: 0 },
        } }],
      } as never] })
      return definition.runId!
    })
    await startBlueprintAutomation()
    expect(useBlueprintAutomation.getState()).toMatchObject({ active: false, error: true })
    expect(useBlueprintAutomation.getState().message).toContain('生成蓝图')
    expect(useBlueprintAutomation.getState().message).toContain('HTTP 429')
    expect(useBlueprintAutomation.getState().message).toContain('配额或余额')
  })

  it('没有实际保存完整批次时停止，防止无限调用', async () => {
    mocks.generate.mockResolvedValue([])
    await startBlueprintAutomation()
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(useBlueprintAutomation.getState().message).toContain('未保存')
  })

  it('停止取消本模式的运行，重复点击不开启第二个任务', async () => {
    let release!: () => void
    mocks.generate.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([]) }))
    const cancel = vi.spyOn(useWorkflowStore.getState(), 'cancelWorkflow').mockImplementation(() => {})
    const running = startBlueprintAutomation()
    await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledOnce())
    await startBlueprintAutomation()
    const runId = vi.mocked(useWorkflowStore.getState().startWorkflow).mock.calls[0][0].runId
    stopBlueprintAutomation()
    expect(cancel).toHaveBeenCalledWith(runId)
    release()
    await running
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(useBlueprintAutomation.getState()).toMatchObject({ active: false, stopping: false, error: false })
  })

  it('相同目录重新打开也停止旧会话', async () => {
    mocks.generate.mockImplementationOnce(async () => { setActiveProjectSessionContext({ ...session, leaseId: 'new-lease' }); return [] })
    await startBlueprintAutomation()
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(useBlueprintAutomation.getState()).toMatchObject({ active: false, error: false })
  })

  it('总章数改变后停止，避免继续使用旧上限', async () => {
    mocks.generate.mockImplementationOnce(async () => {
      const project = useProjectStore.getState().currentProject!
      useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...project.novelConfig, totalChapters: 3 } } })
      return []
    })
    await startBlueprintAutomation()
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(useBlueprintAutomation.getState().message).toContain('总章数已变化')
  })

  it('有未保存蓝图时停止并保留本地内容', async () => {
    useEditorStore.setState({ draftLedgers: { 'chapter-card-editor': JSON.stringify({ version: 1, projects: [{ projectKey: session.projectPath, blueprints: [], dirtyChapterNumbers: [1] }] }) } })
    await startBlueprintAutomation()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(useBlueprintAutomation.getState().message).toContain('未保存')
  })

  it('角色同步尚未完成时停止，不误报规划完成', async () => {
    pendingSync = true
    await startBlueprintAutomation()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(useBlueprintAutomation.getState().message).toContain('重试角色同步')
  })

  it('原有必备条件不满足时停止，允许的架构提示不阻塞自动化', async () => {
    mocks.guard.mockResolvedValueOnce({ ok: false, message: '请先生成角色' })
    await startBlueprintAutomation()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(useBlueprintAutomation.getState().message).toContain('请先生成角色')
    mocks.guard.mockResolvedValue({ ok: true, message: '部分架构尚未生成' })
    await startBlueprintAutomation()
    expect(planned.size).toBe(12)
  })

  it.each([0, -1, 1.5])('非法总章数 %s 不发起规划', async totalChapters => {
    const project = useProjectStore.getState().currentProject!
    useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...project.novelConfig, totalChapters } } })
    await startBlueprintAutomation()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(useBlueprintAutomation.getState().error).toBe(true)
  })
})
