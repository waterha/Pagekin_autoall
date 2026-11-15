import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectData, ProjectSessionContext } from '../../shared/ipc-channels'
import { setActiveProjectSessionContext } from '../../shared/project-session-context'
import { PLOT_OUTLINE_PROTOCOL, renderPlotOutlineSynopsis } from '../../shared/plot-outline-contract'
import { useProjectStore } from '../../stores/project-store'
import { useEditorStore } from '../../stores/editor-store'
import { useLLMStore } from '../../stores/llm-store'
import { useWorkflowStore, type WorkflowContext, type WorkflowDefinition } from '../../stores/workflow-store'
import { startOutlineAutomation, stopOutlineAutomation, useOutlineAutomation } from '../outline-automation'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), config: vi.fn(), guard: vi.fn(), generate: vi.fn() }))
vi.mock('../ipc-client', () => ({ ipc: { invokeWithProjectSession: mocks.invoke, invoke: mocks.config } }))
vi.mock('../workflow-guards', () => ({ guardArchitectureGeneration: mocks.guard }))
vi.mock('../workflows/commands/architecture.command', () => ({
  GeneratePlotArchitectureCommand: class {
    constructor(private selected: string[], private snapshot: unknown, _dependencies: unknown, private options: unknown) {}
    execute(input: unknown) { return mocks.generate(this.selected, this.snapshot, this.options, input) }
  },
}))

const session: ProjectSessionContext = { projectId: 'book', leaseId: 'lease', projectPath: 'C:/books/auto' }
const recoveryHandle = { projectId: 'book', epoch: 'previous-lease', rootActionId: 'root', runId: 'saved-run' }
let core: { synopsis: string; totalChapters: number; writingLanguage: 'zh-CN'; premise: string; charactersArch: string; worldbuilding: string }
let checkpoint: Record<string, unknown> | null
const outlineBody = (end: number) => Array.from({ length: end }, (_, index) =>
  `## 第${index + 1}章：新的发现\n主角在调查失踪事件时发现新的线索，作出选择并付出代价，前往下一个目标。`).join('\n\n')
const saveThrough = (end: number) => {
  core.synopsis = renderPlotOutlineSynopsis(outlineBody(end), end, core)
  checkpoint = { synopsis_incomplete: false, synopsis_range: { from: Math.max(1, end - 4), to: end }, synopsis_covered_to: end }
}

beforeEach(() => {
  vi.resetAllMocks()
  core = { synopsis: '', totalChapters: 12, writingLanguage: 'zh-CN', premise: '前提', charactersArch: '角色', worldbuilding: '世界观' }
  checkpoint = null
  setActiveProjectSessionContext(session)
  useProjectStore.setState({ currentProject: { id: 'book', sessionLease: 'lease', path: session.projectPath,
    novelConfig: { totalChapters: 12, wordsPerChapter: 1800 } } as ProjectData })
  useEditorStore.setState({ tabs: [] })
  useLLMStore.setState({ models: [{ id: 'planner', purposes: ['generation'] }] as never, defaultModelId: 'planner', stageModelIds: {} })
  useWorkflowStore.setState({ history: [], activeRuns: [] })
  useOutlineAutomation.setState({ session: null, active: false, stopping: false, message: '', error: false, startChapter: null, endChapter: null })
  mocks.guard.mockReturnValue({ ok: true })
  mocks.config.mockResolvedValue({ outlineTargetUnits: 700 })
  mocks.invoke.mockImplementation(async (_session: unknown, channel: string) => {
    if (channel === 'db:project-core-get') return { ...core }
    if (channel === 'fs:read-json') return checkpoint ? { success: true, data: structuredClone(checkpoint) } : { success: false }
    if (channel === 'generation:read-context') return { handle: recoveryHandle }
    throw new Error(`Unexpected channel: ${channel}`)
  })
  mocks.generate.mockImplementation(async (_selected: unknown, _snapshot: unknown, options: { resumeSynopsis?: boolean; synopsisRange: { to: number } }) => {
    saveThrough(options.resumeSynopsis ? (checkpoint!.synopsis_range as { to: number }).to : options.synopsisRange.to)
    return core.synopsis
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

const ranges = () => mocks.generate.mock.calls.map(call => call[2].synopsisRange)

describe('情节大纲自动化', () => {
  it('沿用真实架构工作流，只生成情节大纲，按5章保存后继续直到全书完成', async () => {
    await startOutlineAutomation()
    expect(ranges()).toEqual([{ from: 1, to: 5 }, { from: 6, to: 10 }, { from: 11, to: 12 }])
    expect(mocks.generate.mock.calls.every(call => call[0].join(',') === 'synopsis')).toBe(true)
    expect(mocks.generate.mock.calls[0][1]).toMatchObject({ targetUnits: 700, expectedProjectPath: session.projectPath })
    expect(useWorkflowStore.getState().startWorkflow).toHaveBeenCalledWith(expect.objectContaining({ generationModelId: 'planner', type: 'architecture_generation' }), false)
    expect(useOutlineAutomation.getState()).toMatchObject({ active: false, error: false, message: expect.stringContaining('全部完成') })
  })

  it('从已保存进度接着生成，保留原有章节', async () => {
    saveThrough(3)
    const prefix = outlineBody(3)
    await startOutlineAutomation()
    expect(ranges()).toEqual([{ from: 4, to: 8 }, { from: 9, to: 12 }])
    expect(core.synopsis).toContain(prefix)
  })

  it('已完成时无需模型，也不再生成', async () => {
    saveThrough(12)
    useLLMStore.setState({ models: [], defaultModelId: undefined })
    await startOutlineAutomation()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.config).not.toHaveBeenCalled()
    expect(useOutlineAutomation.getState().error).toBe(false)
  })

  it.each([0, 5])('正式大纲已存%s章时，先用准确的旧运行恢复未完成批次，再自动续批', async saved => {
    if (saved) saveThrough(saved)
    checkpoint = { synopsis_incomplete: true, synopsis_protocol: PLOT_OUTLINE_PROTOCOL,
      synopsis_generation_handle: recoveryHandle, synopsis_range: { from: saved + 1, to: saved + 5 } }
    await startOutlineAutomation()
    expect(mocks.generate.mock.calls[0][2]).toMatchObject({ resumeSynopsis: true, resumeHandle: recoveryHandle })
    expect(ranges()[1]).toEqual({ from: saved + 6, to: Math.min(12, saved + 10) })
    expect(useOutlineAutomation.getState().error).toBe(false)
  })

  it('失败停止并保留上批，再次开启从保存进度续接', async () => {
    mocks.generate.mockImplementationOnce(async () => { saveThrough(5); return core.synopsis })
      .mockRejectedValueOnce(new Error('网络中断'))
    await startOutlineAutomation()
    expect(mocks.generate).toHaveBeenCalledTimes(2)
    expect(core.synopsis).toContain('第5章')
    expect(useOutlineAutomation.getState().message).toContain('网络中断')
    await startOutlineAutomation()
    expect(ranges()[2]).toEqual({ from: 6, to: 10 })
    expect(useOutlineAutomation.getState().error).toBe(false)
  })

  it.each(['unchanged', 'incomplete', 'short'])('工作流完成却未保存完整批次（%s）时停止，防止循环调用', async kind => {
    mocks.generate.mockImplementation(async () => {
      if (kind === 'short') saveThrough(3)
      if (kind === 'incomplete') { saveThrough(5); checkpoint!.synopsis_incomplete = true }
      return core.synopsis
    })
    await startOutlineAutomation()
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(useOutlineAutomation.getState().message).toContain('尚未完整保存')
  })

  it('手动破坏的分批说明不会被覆盖重写', async () => {
    saveThrough(5)
    core.synopsis += '\n手动修改'
    const original = core.synopsis
    await startOutlineAutomation()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(core.synopsis).toBe(original)
    expect(useOutlineAutomation.getState().error).toBe(true)
  })

  it('旧中断候选没有运行记录时保留并停止', async () => {
    checkpoint = { synopsis_incomplete: true, synopsis_result: '旧候选', synopsis_range: { from: 1, to: 5 } }
    await startOutlineAutomation()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(useOutlineAutomation.getState().message).toContain('恢复稿')
  })

  it('停止仅取消本模式的运行，重复开启不会启动第二个任务', async () => {
    let release!: () => void
    mocks.generate.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve('') }))
    const cancel = vi.spyOn(useWorkflowStore.getState(), 'cancelWorkflow').mockImplementation(() => {})
    const running = startOutlineAutomation()
    await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledOnce())
    await startOutlineAutomation()
    const runId = vi.mocked(useWorkflowStore.getState().startWorkflow).mock.calls[0][0].runId
    stopOutlineAutomation()
    expect(cancel).toHaveBeenCalledWith(runId)
    release()
    await running
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(useOutlineAutomation.getState()).toMatchObject({ active: false, stopping: false, error: false })
  })

  it('同一目录重开时停止旧会话', async () => {
    mocks.generate.mockImplementationOnce(async () => { setActiveProjectSessionContext({ ...session, leaseId: 'new-lease' }); return '' })
    await startOutlineAutomation()
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(useOutlineAutomation.getState()).toMatchObject({ active: false, error: false })
  })

  it('修改总章数时不继续使用旧上限', async () => {
    mocks.generate.mockImplementationOnce(async () => {
      const project = useProjectStore.getState().currentProject!
      useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...project.novelConfig, totalChapters: 3 } } })
      return ''
    })
    await startOutlineAutomation()
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(useOutlineAutomation.getState().message).toContain('总章数已变化')
  })

  it('架构有未保存修改时保留编辑内容，并忽略其他作品的脏标签', async () => {
    useEditorStore.setState({ tabs: [{ id: 'arch', name: '大纲', type: 'arch-file', projectKey: session.projectPath,
      content: '未保存', savedContent: '', dirty: false }] })
    await startOutlineAutomation()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(useOutlineAutomation.getState().message).toContain('未保存')
    useEditorStore.setState({ tabs: [{ id: 'other', name: '大纲', type: 'arch-file', projectKey: 'C:/other', dirty: true }] })
    await startOutlineAutomation()
    expect(useOutlineAutomation.getState().error).toBe(false)
  })

  it('必备架构不全时不消耗模型调用', async () => {
    core.charactersArch = ''
    await startOutlineAutomation()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(useOutlineAutomation.getState().message).toContain('请先完成')
  })

  it('原有配置前置条件不通过时显示原因', async () => {
    mocks.guard.mockReturnValue({ ok: false, message: '请填写小说配置' })
    await startOutlineAutomation()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(useOutlineAutomation.getState().message).toContain('请填写小说配置')
  })

  it.each([0, -1, 1.5])('非法总章数%s不发起请求', async totalChapters => {
    const project = useProjectStore.getState().currentProject!
    useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...project.novelConfig, totalChapters } } })
    await startOutlineAutomation()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(useOutlineAutomation.getState().error).toBe(true)
  })
})
