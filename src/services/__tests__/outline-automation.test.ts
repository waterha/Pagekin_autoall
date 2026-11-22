import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectData, ProjectSessionContext } from '../../shared/ipc-channels'
import type { GenerationRecoveryContext } from '../../shared/generation-owner-contract'
import { setActiveProjectSessionContext } from '../../shared/project-session-context'
import { PLOT_OUTLINE_PROTOCOL, renderPlotOutlineSynopsis } from '../../shared/plot-outline-contract'
import { useProjectStore } from '../../stores/project-store'
import { registerEditorExitSaveHandler, useEditorStore } from '../../stores/editor-store'
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
let recoveryContext: GenerationRecoveryContext | undefined
const outlineBody = (end: number) => Array.from({ length: end }, (_, index) =>
  `## 第${index + 1}章：新的发现\n主角在调查失踪事件时发现新的线索，作出选择并付出代价，前往下一个目标。`).join('\n\n')
const saveThrough = (end: number) => {
  core.synopsis = renderPlotOutlineSynopsis(outlineBody(end), end, core)
  checkpoint = { synopsis_incomplete: false, synopsis_range: { from: Math.max(1, end - 4), to: end }, synopsis_covered_to: end }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  core = { synopsis: '', totalChapters: 12, writingLanguage: 'zh-CN', premise: '前提', charactersArch: '角色', worldbuilding: '世界观' }
  checkpoint = null
  recoveryContext = undefined
  setActiveProjectSessionContext(session)
  useProjectStore.setState({ currentProject: { id: 'book', sessionLease: 'lease', path: session.projectPath,
    novelConfig: { totalChapters: 12, wordsPerChapter: 1800 } } as ProjectData })
  useEditorStore.setState({ tabs: [] })
  useLLMStore.setState({ models: [{ id: 'planner', purposes: ['generation'] }] as never, defaultModelId: 'planner', stageModelIds: {} })
  useWorkflowStore.setState({ history: [], activeRuns: [] })
  useOutlineAutomation.setState({ session: null, active: false, stopping: false, message: '', error: false, startChapter: null, endChapter: null, phase: 'generating' })
  mocks.guard.mockReturnValue({ ok: true })
  mocks.config.mockResolvedValue({ outlineTargetUnits: 700 })
  mocks.invoke.mockImplementation(async (_session: unknown, channel: string) => {
    if (channel === 'db:project-core-get') return { ...core }
    if (channel === 'fs:read-json') return checkpoint ? { success: true, data: structuredClone(checkpoint) } : { success: false }
    if (channel === 'generation:read-context') return recoveryContext ?? {
      handle: recoveryHandle, plotOutline: { range: checkpoint?.synopsis_range ?? { from: 1, to: 5 }, cursor: { kind: 'request' } },
      plotOutlineRecovery: { leaseEpoch: session.leaseId, writeState: { kind: 'ready' } },
    }
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
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); setActiveProjectSessionContext(null) })

const ranges = () => mocks.generate.mock.calls.map(call => call[2].synopsisRange)
const runAutomation = async () => {
  const running = startOutlineAutomation()
  await vi.runAllTimersAsync()
  await running
}

function seedExhaustedRecovery(accepted = 2, reason: 'attempts-exhausted' | 'unknown-completion' = 'attempts-exhausted') {
  checkpoint = { synopsis_incomplete: true, synopsis_protocol: PLOT_OUTLINE_PROTOCOL,
    synopsis_generation_handle: recoveryHandle, synopsis_range: { from: 1, to: 5 } }
  const sourceExpected = { ...core, wordsPerChapter: 1800, genre: '', plotStructure: 'three_act', narrativePov: 'third_limited', globalGuidance: '' }
  recoveryContext = {
    handle: recoveryHandle, operation: 'generate-plot-outline', modelId: 'planner', authorInputs: [], selectedDraftIds: [], selectedFinalizedDraftIds: [],
    selectedBlueprintChapterNumbers: [], composition: null, lastCompositionFinishReason: 'length', attemptedPurposes: [], draftSave: { kind: 'absent' },
    planningDraft: { standing: 'open', createdAtMs: 1, requestedRange: { from: 1, to: 5 } },
    planningContinuation: { state: accepted ? 'save-prefix' : 'ready', sourceHandle: recoveryHandle, remainingRange: { from: 1, to: 5 }, targetUnits: 700 },
    plotOutline: { range: { from: 1, to: 5 }, protocol: PLOT_OUTLINE_PROTOCOL, content: { maxAttemptsPerChapter: 2 }, targetUnits: 700,
      cursor: { kind: 'stopped', chapterNumber: accepted + 1, reason }, sourceExpected, confirmedPrefix: '',
      composition: accepted ? { algorithm: PLOT_OUTLINE_PROTOCOL, text: outlineBody(accepted), textHash: 'hash', artifactIds: ['accepted'], sources: [],
        chapters: Array.from({ length: accepted }, (_, index) => ({ chapterNumber: index + 1, artifactIds: ['accepted'], textHash: 'hash' })) } : null },
    plotOutlineRecovery: { sourceHandle: recoveryHandle, leaseEpoch: session.leaseId, completeChapters: Array.from({ length: accepted }, (_, index) => index + 1),
      draft: `${outlineBody(accepted)}\n## 第${accepted + 1}章：未完成\n模型还没写完`, writeState: { kind: 'ready' }, saved: null, inFormalOutline: false },
  }
  const invoke = mocks.invoke.getMockImplementation()!
  mocks.invoke.mockImplementation(async (owner, channel, ...args) => {
    if (channel === 'db:project-core-synopsis-commit') {
      const request = args[0]
      core.synopsis = request.synopsis
      recoveryContext!.plotOutlineRecovery!.saved = { kind: 'author-edit', ...request.authorRecovery,
        requestedRange: { from: 1, to: 5 }, remainingRange: { from: accepted + 1, to: 5 }, synopsisHash: 'saved', payloadHash: 'payload', idempotent: false }
      recoveryContext!.plotOutlineRecovery!.writeState = { kind: 'blocked', reason: 'author-saved' }
      recoveryContext!.planningContinuation = { state: 'ready', sourceHandle: recoveryHandle, remainingRange: { from: accepted + 1, to: 5 }, targetUnits: 700 }
      return { success: true }
    }
    return invoke(owner, channel, ...args)
  })
}

describe('情节大纲自动化', () => {
  it('自动保存恢复稿中的完整前缀，再按原续写入口仅生成缺少的章节', async () => {
    seedExhaustedRecovery()
    await runAutomation()
    const saves = mocks.invoke.mock.calls.filter(call => call[1] === 'db:project-core-synopsis-commit')
    expect(saves).toHaveLength(1)
    expect(saves[0][2]).toMatchObject({ authorRecovery: { sourceHandle: recoveryHandle, committedRange: { from: 1, to: 2 } } })
    expect(saves[0][2].synopsis).not.toContain('未完成')
    expect(saves[0][2].synopsis).not.toContain('第3章')
    expect(mocks.generate.mock.calls[0][2]).toMatchObject({ restartHandle: recoveryHandle, synopsisRange: { from: 3, to: 5 } })
    expect(ranges()).toEqual([{ from: 3, to: 5 }, { from: 6, to: 10 }, { from: 11, to: 12 }])
    expect(useOutlineAutomation.getState().error).toBe(false)
  })

  it('恢复稿没有完整章节时直接继续本批，不保存半截内容', async () => {
    seedExhaustedRecovery(0)
    await runAutomation()
    expect(mocks.invoke.mock.calls.some(call => call[1] === 'db:project-core-synopsis-commit')).toBe(false)
    expect(mocks.generate.mock.calls[0][2]).toMatchObject({ restartHandle: recoveryHandle, synopsisRange: { from: 1, to: 5 } })
    expect(useOutlineAutomation.getState().error).toBe(false)
  })

  // 真实案例（第 129 章）：调用 49ms 就被服务商拒绝，尝试停在 unknown-completion。
  // 恢复稿里已经有完整章节，但自动化只认 attempts-exhausted，于是直接抛错卡住，
  // 只能靠人工点「继续生成缺少的章节」。自动化必须自己走这条路。
  it('恢复稿停在 unknown-completion 时也保存完整前缀并继续生成缺少的章节', async () => {
    seedExhaustedRecovery(2, 'unknown-completion')
    await runAutomation()
    const saves = mocks.invoke.mock.calls.filter(call => call[1] === 'db:project-core-synopsis-commit')
    expect(saves).toHaveLength(1)
    expect(saves[0][2]).toMatchObject({ authorRecovery: { committedRange: { from: 1, to: 2 } } })
    expect(saves[0][2].synopsis).not.toContain('未完成')
    expect(mocks.generate.mock.calls[0][2]).toMatchObject({ restartHandle: recoveryHandle, synopsisRange: { from: 3, to: 5 } })
    expect(useOutlineAutomation.getState().error).toBe(false)
  })

  it('unknown-completion 且本批一章都没完成时，直接从本批起点重新生成而不是卡住', async () => {
    seedExhaustedRecovery(0, 'unknown-completion')
    await runAutomation()
    expect(mocks.invoke.mock.calls.some(call => call[1] === 'db:project-core-synopsis-commit')).toBe(false)
    expect(mocks.generate.mock.calls[0][2]).toMatchObject({ restartHandle: recoveryHandle, synopsisRange: { from: 1, to: 5 } })
    expect(useOutlineAutomation.getState().error).toBe(false)
  })

  // 现场数据：第 129 章调用 49ms 被服务商拒绝，游标停在 unknown-completion，范围 129–133，正式大纲写到 128。
  it('第 129 章 unknown-completion 的真实形状：保存本批已完成的前缀后只重生成缺少的章节', async () => {
    // 现场是 200 章的长篇；fixture 默认 12 章，先按实现的章数铺好已保存的前缀。
    core.totalChapters = 200
    useProjectStore.setState({ currentProject: { ...useProjectStore.getState().currentProject!,
      novelConfig: { ...useProjectStore.getState().currentProject!.novelConfig, totalChapters: 200 } } })
    saveThrough(128)
    checkpoint = { synopsis_incomplete: true, synopsis_protocol: PLOT_OUTLINE_PROTOCOL,
      synopsis_generation_handle: recoveryHandle, synopsis_range: { from: 129, to: 133 }, synopsis_covered_to: 128 }
    const sourceExpected = { ...core, wordsPerChapter: 1800, genre: '', plotStructure: 'three_act', narrativePov: 'third_limited', globalGuidance: '' }
    const acceptedBody = Array.from({ length: 2 }, (_, index) =>
      `## 第${129 + index}章：新的发现\n主角在调查失踪事件时发现新的线索，作出选择并付出代价，前往下一个目标。`).join('\n\n')
    recoveryContext = {
      handle: recoveryHandle, operation: 'generate-plot-outline', modelId: 'planner', authorInputs: [], selectedDraftIds: [], selectedFinalizedDraftIds: [],
      selectedBlueprintChapterNumbers: [], composition: null, lastCompositionFinishReason: 'length', attemptedPurposes: [], draftSave: { kind: 'absent' },
      planningDraft: { standing: 'open', createdAtMs: 1, requestedRange: { from: 129, to: 133 } },
      planningContinuation: { state: 'save-prefix', sourceHandle: recoveryHandle, remainingRange: { from: 129, to: 133 }, targetUnits: 700 },
      plotOutline: { range: { from: 129, to: 133 }, protocol: PLOT_OUTLINE_PROTOCOL, content: { maxAttemptsPerChapter: 2 }, targetUnits: 700,
        cursor: { kind: 'stopped', chapterNumber: 131, reason: 'unknown-completion' }, sourceExpected, confirmedPrefix: '',
        composition: { algorithm: PLOT_OUTLINE_PROTOCOL, text: acceptedBody, textHash: 'hash', artifactIds: ['accepted'], sources: [],
          chapters: [{ chapterNumber: 129, artifactIds: ['accepted'], textHash: 'hash' }, { chapterNumber: 130, artifactIds: ['accepted'], textHash: 'hash' }] } },
      plotOutlineRecovery: { sourceHandle: recoveryHandle, leaseEpoch: session.leaseId, completeChapters: [129, 130],
        draft: `${acceptedBody}\n## 第131章：未完成\n`, writeState: { kind: 'ready' }, saved: null, inFormalOutline: false },
    }
    const invoke = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation(async (owner, channel, ...args) => {
      if (channel === 'db:project-core-synopsis-commit') {
        const request = args[0]
        core.synopsis = request.synopsis
        recoveryContext!.plotOutlineRecovery!.saved = { kind: 'author-edit', ...request.authorRecovery,
          requestedRange: { from: 129, to: 133 }, remainingRange: { from: 131, to: 133 }, synopsisHash: 'saved', payloadHash: 'payload', idempotent: false }
        recoveryContext!.plotOutlineRecovery!.writeState = { kind: 'blocked', reason: 'author-saved' }
        recoveryContext!.plotOutlineRecovery!.completeChapters = []
        recoveryContext!.plotOutline!.composition = null
        recoveryContext!.plotOutline!.cursor = { kind: 'stopped', chapterNumber: 131, reason: 'unknown-completion' }
        recoveryContext!.planningContinuation = { state: 'ready', sourceHandle: recoveryHandle, remainingRange: { from: 131, to: 133 }, targetUnits: 700 }
        return { success: true }
      }
      return invoke(owner, channel, ...args)
    })
    await runAutomation()
    const saves = mocks.invoke.mock.calls.filter(call => call[1] === 'db:project-core-synopsis-commit')
    expect(saves).toHaveLength(1)
    expect(saves[0][2]).toMatchObject({ authorRecovery: { committedRange: { from: 129, to: 130 } } })
    expect(saves[0][2].synopsis).toContain('第130章')
    expect(saves[0][2].synopsis).not.toContain('第131章')
    // 本批 129–130 已保存，接着只生成缺少的 131–133。
    expect(ranges()[0]).toEqual({ from: 131, to: 133 })
    expect(useOutlineAutomation.getState().error).toBe(false)
  })

  it('保存成功但响应丢失时重新核对收据，不重复写入前缀', async () => {
    seedExhaustedRecovery()
    const invoke = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation(async (owner, channel, ...args) => {
      const result = await invoke(owner, channel, ...args)
      if (channel === 'db:project-core-synopsis-commit') throw new Error('NETWORK_ERROR: response lost')
      return result
    })
    await runAutomation()
    expect(mocks.invoke.mock.calls.filter(call => call[1] === 'db:project-core-synopsis-commit')).toHaveLength(1)
    expect(mocks.generate.mock.calls[0][2]).toMatchObject({ restartHandle: recoveryHandle, synopsisRange: { from: 3, to: 5 } })
    expect(useOutlineAutomation.getState().error).toBe(false)
  })

  it.each(['source-changed', 'source-invalid', 'in-flight'] as const)('恢复稿%s时保留所有原文，停止无效重试', async state => {
    seedExhaustedRecovery()
    recoveryContext!.planningContinuation!.state = state
    recoveryContext!.plotOutlineRecovery!.writeState = { kind: 'blocked', reason: state }
    await runAutomation()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.invoke.mock.calls.some(call => call[1] === 'db:project-core-synopsis-commit')).toBe(false)
    expect(useOutlineAutomation.getState().error).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('保存调用临时失败会重试同一份前缀和操作标识', async () => {
    seedExhaustedRecovery()
    const invoke = mocks.invoke.getMockImplementation()!
    let failed = false
    mocks.invoke.mockImplementation(async (owner, channel, ...args) => {
      if (channel === 'db:project-core-synopsis-commit' && !failed) { failed = true; return { success: false, error: 'SQLITE_BUSY' } }
      return invoke(owner, channel, ...args)
    })
    await runAutomation()
    const saves = mocks.invoke.mock.calls.filter(call => call[1] === 'db:project-core-synopsis-commit')
    expect(saves).toHaveLength(2)
    expect(saves[0][2]).toEqual(saves[1][2])
    expect(useOutlineAutomation.getState().error).toBe(false)
  })

  // 现场：架构工作流先抛「第 129 章已停止自动生成，原因 unknown-completion」，
  // 自动化必须接住它、保存已完成的章，再继续生成，而不是把这句话当成终点停下来。
  it('工作流报 unknown-completion 停止时自动接住，保存已完成章后继续，不卡死', async () => {
    core.totalChapters = 200
    useProjectStore.setState({ currentProject: { ...useProjectStore.getState().currentProject!,
      novelConfig: { ...useProjectStore.getState().currentProject!.novelConfig, totalChapters: 200 } } })
    saveThrough(128)
    const acceptedBody = Array.from({ length: 2 }, (_, index) =>
      `## 第${129 + index}章：新的发现\n主角在调查失踪事件时发现新的线索，作出选择并付出代价，前往下一个目标。`).join('\n\n')
    const sourceExpected = { ...core, wordsPerChapter: 1800, genre: '', plotStructure: 'three_act', narrativePov: 'third_limited', globalGuidance: '' }
    // 第一次生成跑到第 131 章被服务商拒绝：工作流抛出停止错误，检查点留下 unknown-completion。
    mocks.generate.mockImplementationOnce(async (_selected, _snapshot, _options, input) => {
      checkpoint = { synopsis_incomplete: true, synopsis_protocol: PLOT_OUTLINE_PROTOCOL,
        synopsis_generation_handle: recoveryHandle, synopsis_range: { from: 129, to: 133 }, synopsis_covered_to: 128 }
      input.context.data.synopsisGenerationHandle = recoveryHandle
      recoveryContext = {
        handle: recoveryHandle, operation: 'generate-plot-outline', modelId: 'planner', authorInputs: [], selectedDraftIds: [], selectedFinalizedDraftIds: [],
        selectedBlueprintChapterNumbers: [], composition: null, lastCompositionFinishReason: 'error', attemptedPurposes: [], draftSave: { kind: 'absent' },
        planningDraft: { standing: 'open', createdAtMs: 1, requestedRange: { from: 129, to: 133 } },
        planningContinuation: { state: 'save-prefix', sourceHandle: recoveryHandle, remainingRange: { from: 129, to: 133 }, targetUnits: 700 },
        plotOutline: { range: { from: 129, to: 133 }, protocol: PLOT_OUTLINE_PROTOCOL, content: { maxAttemptsPerChapter: 2 }, targetUnits: 700,
          cursor: { kind: 'stopped', chapterNumber: 131, reason: 'unknown-completion' }, sourceExpected, confirmedPrefix: '',
          composition: { algorithm: PLOT_OUTLINE_PROTOCOL, text: acceptedBody, textHash: 'hash', artifactIds: ['accepted'], sources: [],
            chapters: [{ chapterNumber: 129, artifactIds: ['accepted'], textHash: 'hash' }, { chapterNumber: 130, artifactIds: ['accepted'], textHash: 'hash' }] } },
        plotOutlineRecovery: { sourceHandle: recoveryHandle, leaseEpoch: session.leaseId, completeChapters: [129, 130],
          draft: `${acceptedBody}\n## 第131章：未完成\n`, writeState: { kind: 'ready' }, saved: null, inFormalOutline: false },
      }
      throw new Error('第 131 章已停止自动生成，原因 unknown-completion。已接受前缀和全部候选已保留，正式大纲未被覆盖。')
    })
    const invoke = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation(async (owner, channel, ...args) => {
      if (channel === 'db:project-core-synopsis-commit') {
        const request = args[0]
        core.synopsis = request.synopsis
        recoveryContext!.plotOutlineRecovery!.saved = { kind: 'author-edit', ...request.authorRecovery,
          requestedRange: { from: 129, to: 133 }, remainingRange: { from: 131, to: 133 }, synopsisHash: 'saved', payloadHash: 'payload', idempotent: false }
        recoveryContext!.plotOutlineRecovery!.writeState = { kind: 'blocked', reason: 'author-saved' }
        recoveryContext!.plotOutlineRecovery!.completeChapters = []
        recoveryContext!.plotOutline!.composition = null
        recoveryContext!.plotOutline!.cursor = { kind: 'stopped', chapterNumber: 131, reason: 'unknown-completion' }
        recoveryContext!.planningContinuation = { state: 'ready', sourceHandle: recoveryHandle, remainingRange: { from: 131, to: 133 }, targetUnits: 700 }
        return { success: true }
      }
      return invoke(owner, channel, ...args)
    })
    await runAutomation()
    // 已完成的 129–130 被保存，之后从 131 接着生成，自动化没有停在 unknown-completion 上。
    const saves = mocks.invoke.mock.calls.filter(call => call[1] === 'db:project-core-synopsis-commit')
    expect(saves).toHaveLength(1)
    expect(saves[0][2]).toMatchObject({ authorRecovery: { committedRange: { from: 129, to: 130 } } })
    expect(ranges().some(range => range.from === 131)).toBe(true)
    expect(useOutlineAutomation.getState().message).not.toContain('unknown-completion')
  })

  it('恢复稿已在正式大纲保存但工作流报错时不重新生成同一批', async () => {
    seedExhaustedRecovery()
    mocks.generate.mockImplementationOnce(async () => {
      saveThrough(5)
      recoveryContext!.plotOutlineRecovery!.inFormalOutline = true
      throw new Error('EBUSY: 检查点保存失败')
    })
    await runAutomation()
    expect(ranges()).toEqual([{ from: 3, to: 5 }, { from: 6, to: 10 }, { from: 11, to: 12 }])
    expect(useOutlineAutomation.getState().error).toBe(false)
  })

  it('持续网络失败最多自动重试3次后停止', async () => {
    mocks.generate.mockRejectedValue(new Error('NETWORK_ERROR'))
    await runAutomation()
    expect(mocks.generate).toHaveBeenCalledTimes(4)
    expect(useOutlineAutomation.getState().message).toContain('重试 3 次')
  })

  it('旧检查点指向已续接且已保存的新运行时跳过旧链条，避免循环恢复', async () => {
    seedExhaustedRecovery(0)
    saveThrough(5)
    checkpoint = { synopsis_incomplete: true, synopsis_generation_handle: recoveryHandle, synopsis_range: { from: 1, to: 5 } }
    const next = { ...recoveryHandle, runId: 'already-saved-successor' }
    recoveryContext!.planningContinuation = { ...recoveryContext!.planningContinuation!, state: 'continued', nextHandle: next }
    const savedContext = structuredClone(recoveryContext!)
    savedContext.handle = next
    savedContext.planningContinuation!.state = 'complete'
    savedContext.plotOutlineRecovery!.inFormalOutline = true
    const invoke = mocks.invoke.getMockImplementation()!
    let reads = 0
    mocks.invoke.mockImplementation(async (owner, channel, ...args) => {
      if (channel === 'generation:read-context') {
        if (++reads > 20) throw new Error('检测到旧链条无限循环')
        if (args[0].handle.runId === next.runId) return savedContext
      }
      return invoke(owner, channel, ...args)
    })
    await runAutomation()
    expect(ranges()).toEqual([{ from: 6, to: 10 }, { from: 11, to: 12 }])
    expect(useOutlineAutomation.getState().error).toBe(false)
  })

  it('检查点尚未写入就报错时，通过工作流捕获的原运行继续恢复', async () => {
    mocks.generate.mockImplementationOnce(async (_selected, _snapshot, _options, input) => {
      input.context.data.synopsisGenerationHandle = recoveryHandle
      throw new Error('EBUSY: 保存检查点失败')
    }).mockImplementationOnce(async () => { saveThrough(5); return core.synopsis })
    await runAutomation()
    expect(mocks.generate.mock.calls[1][2]).toMatchObject({ resumeHandle: recoveryHandle })
    expect(useOutlineAutomation.getState().error).toBe(false)
  })

  it('普通架构自动保存临时失败后重试，写入成功才调用模型', async () => {
    const content = renderPlotOutlineSynopsis(outlineBody(3), 3, core)
    useEditorStore.setState({ tabs: [{ id: 'retry-save', name: '大纲', type: 'arch-file', projectKey: session.projectPath,
      filePath: 'ai-novel://core/synopsis', content, savedContent: '', dirty: true }] })
    const invoke = mocks.invoke.getMockImplementation()!
    let saves = 0
    mocks.invoke.mockImplementation(async (owner, channel, ...args) => {
      if (channel === 'db:project-core-update') {
        expect(mocks.generate).not.toHaveBeenCalled()
        if (++saves === 1) return { success: false, error: 'SQLITE_BUSY' }
        core.synopsis = args[0].synopsis
        return { success: true }
      }
      return invoke(owner, channel, ...args)
    })
    await runAutomation()
    expect(saves).toBe(2)
    expect(ranges()[0]).toEqual({ from: 4, to: 8 })
    expect(useOutlineAutomation.getState().error).toBe(false)
  })

  it('重试等待期间按停止可立即退出，不再发起请求', async () => {
    mocks.generate.mockRejectedValue(new Error('NETWORK_ERROR'))
    const running = startOutlineAutomation()
    await vi.advanceTimersByTimeAsync(0)
    expect(useOutlineAutomation.getState().phase).toBe('retrying')
    stopOutlineAutomation()
    await running
    await vi.runAllTimersAsync()
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(useOutlineAutomation.getState()).toMatchObject({ active: false, error: false })
  })

  it('自动保存沿用编辑器注册的保存操作，保存中继续输入会再次保存', async () => {
    const tab = { id: 'registered', name: '大纲', type: 'arch-file' as const, projectKey: session.projectPath,
      filePath: 'ai-novel://core/synopsis', content: 'first', savedContent: '', dirty: true, contentRevision: 1 }
    useEditorStore.setState({ tabs: [tab] })
    const save = vi.fn(async () => {
      const current = useEditorStore.getState().tabs[0]
      if (save.mock.calls.length === 1) useEditorStore.getState().updateTabContent(tab.id, 'second')
      useEditorStore.getState().settleTabSave(tab.id, { content: current.content!, contentRevision: current.contentRevision! })
    })
    const unregister = registerEditorExitSaveHandler({ tabId: tab.id, type: 'arch-file', projectKey: session.projectPath, save })
    try {
      await runAutomation()
      expect(save).toHaveBeenCalledTimes(2)
      expect(useEditorStore.getState().tabs[0]).toMatchObject({ content: 'second', dirty: false })
      expect(useOutlineAutomation.getState().error).toBe(false)
    } finally { unregister() }
  })

  it('自动保存未保存的大纲编辑后继续批量生成', async () => {
    const content = renderPlotOutlineSynopsis(outlineBody(3), 3, core)
    useEditorStore.setState({ tabs: [{ id: 'arch', name: '大纲', type: 'arch-file', projectKey: session.projectPath,
      filePath: 'ai-novel://core/synopsis', content, savedContent: '', dirty: true }] })
    const invoke = mocks.invoke.getMockImplementation()!
    mocks.invoke.mockImplementation(async (owner, channel, ...args) => {
      if (channel === 'db:project-core-update') { core.synopsis = args[0].synopsis; return { success: true } }
      return invoke(owner, channel, ...args)
    })
    await runAutomation()
    expect(ranges()).toEqual([{ from: 4, to: 8 }, { from: 9, to: 12 }])
    expect(useEditorStore.getState().tabs[0].dirty).toBe(false)
    expect(useOutlineAutomation.getState().error).toBe(false)
  })

  it('本批保存遇到临时错误后自动恢复相同运行，成功后继续下一批', async () => {
    mocks.generate.mockImplementationOnce(async () => {
      checkpoint = { synopsis_incomplete: true, synopsis_protocol: PLOT_OUTLINE_PROTOCOL,
        synopsis_generation_handle: recoveryHandle, synopsis_range: { from: 1, to: 5 } }
      throw new Error('EBUSY: 保存大纲失败')
    })
    await runAutomation()
    expect(mocks.generate.mock.calls[1]?.[2]).toMatchObject({ resumeSynopsis: true, resumeHandle: recoveryHandle })
    expect(useOutlineAutomation.getState()).toMatchObject({ active: false, error: false, message: expect.stringContaining('全部完成') })
  })

  it('沿用真实架构工作流，只生成情节大纲，按5章保存后继续直到全书完成', async () => {
    await runAutomation()
    expect(ranges()).toEqual([{ from: 1, to: 5 }, { from: 6, to: 10 }, { from: 11, to: 12 }])
    expect(mocks.generate.mock.calls.every(call => call[0].join(',') === 'synopsis')).toBe(true)
    expect(mocks.generate.mock.calls[0][1]).toMatchObject({ targetUnits: 700, expectedProjectPath: session.projectPath })
    expect(useWorkflowStore.getState().startWorkflow).toHaveBeenCalledWith(expect.objectContaining({ generationModelId: 'planner', type: 'architecture_generation' }), false)
    expect(useOutlineAutomation.getState()).toMatchObject({ active: false, error: false, message: expect.stringContaining('全部完成') })
  })

  it('从已保存进度接着生成，保留原有章节', async () => {
    saveThrough(3)
    const prefix = outlineBody(3)
    await runAutomation()
    expect(ranges()).toEqual([{ from: 4, to: 8 }, { from: 9, to: 12 }])
    expect(core.synopsis).toContain(prefix)
  })

  it('已完成时无需模型，也不再生成', async () => {
    saveThrough(12)
    useLLMStore.setState({ models: [], defaultModelId: undefined })
    await runAutomation()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.config).not.toHaveBeenCalled()
    expect(useOutlineAutomation.getState().error).toBe(false)
  })

  it.each([0, 5])('正式大纲已存%s章时，先用准确的旧运行恢复未完成批次，再自动续批', async saved => {
    if (saved) saveThrough(saved)
    checkpoint = { synopsis_incomplete: true, synopsis_protocol: PLOT_OUTLINE_PROTOCOL,
      synopsis_generation_handle: recoveryHandle, synopsis_range: { from: saved + 1, to: saved + 5 } }
    await runAutomation()
    expect(mocks.generate.mock.calls[0][2]).toMatchObject({ resumeSynopsis: true, resumeHandle: recoveryHandle })
    expect(ranges()[1]).toEqual({ from: saved + 6, to: Math.min(12, saved + 10) })
    expect(useOutlineAutomation.getState().error).toBe(false)
  })

  it('临时网络错误自动重试，从已保存进度继续直到完成', async () => {
    mocks.generate.mockImplementationOnce(async () => { saveThrough(5); return core.synopsis })
      .mockRejectedValueOnce(new Error('网络中断'))
    await runAutomation()
    expect(ranges()[2]).toEqual({ from: 6, to: 10 })
    expect(core.synopsis).toContain('第12章')
    expect(useOutlineAutomation.getState().error).toBe(false)
  })

  it.each(['unchanged', 'incomplete', 'short'])('工作流完成却未保存完整批次（%s）时停止，防止循环调用', async kind => {
    mocks.generate.mockImplementation(async () => {
      if (kind === 'short') saveThrough(3)
      if (kind === 'incomplete') { saveThrough(5); checkpoint!.synopsis_incomplete = true }
      return core.synopsis
    })
    await runAutomation()
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(useOutlineAutomation.getState().message).toContain('尚未完整保存')
  })

  it('手动破坏的分批说明不会被覆盖重写', async () => {
    saveThrough(5)
    core.synopsis += '\n手动修改'
    const original = core.synopsis
    await runAutomation()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(core.synopsis).toBe(original)
    expect(useOutlineAutomation.getState().error).toBe(true)
  })

  it('旧中断候选没有运行记录时保留并停止', async () => {
    checkpoint = { synopsis_incomplete: true, synopsis_result: '旧候选', synopsis_range: { from: 1, to: 5 } }
    await runAutomation()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(useOutlineAutomation.getState().message).toContain('恢复稿')
  })

  it('停止仅取消本模式的运行，重复开启不会启动第二个任务', async () => {
    let release!: () => void
    mocks.generate.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve('') }))
    const cancel = vi.spyOn(useWorkflowStore.getState(), 'cancelWorkflow').mockImplementation(() => {})
    const running = startOutlineAutomation()
    await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledOnce())
    await runAutomation()
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
    await runAutomation()
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(useOutlineAutomation.getState()).toMatchObject({ active: false, error: false })
  })

  it('修改总章数时不继续使用旧上限', async () => {
    mocks.generate.mockImplementationOnce(async () => {
      const project = useProjectStore.getState().currentProject!
      useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...project.novelConfig, totalChapters: 3 } } })
      return ''
    })
    await runAutomation()
    expect(mocks.generate).toHaveBeenCalledOnce()
    expect(useOutlineAutomation.getState().message).toContain('总章数已变化')
  })

  it('架构有未保存修改时保留编辑内容，并忽略其他作品的脏标签', async () => {
    useEditorStore.setState({ tabs: [{ id: 'arch', name: '大纲', type: 'arch-file', projectKey: session.projectPath,
      content: '未保存', savedContent: '', dirty: false }] })
    await runAutomation()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(useOutlineAutomation.getState().message).toContain('无法自动保存')
    useEditorStore.setState({ tabs: [{ id: 'other', name: '大纲', type: 'arch-file', projectKey: 'C:/other', dirty: true }] })
    await runAutomation()
    expect(useOutlineAutomation.getState().error).toBe(false)
  })

  it('必备架构不全时不消耗模型调用', async () => {
    core.charactersArch = ''
    await runAutomation()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(useOutlineAutomation.getState().message).toContain('请先完成')
  })

  it('原有配置前置条件不通过时显示原因', async () => {
    mocks.guard.mockReturnValue({ ok: false, message: '请填写小说配置' })
    await runAutomation()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(useOutlineAutomation.getState().message).toContain('请填写小说配置')
  })

  it.each([0, -1, 1.5])('非法总章数%s不发起请求', async totalChapters => {
    const project = useProjectStore.getState().currentProject!
    useProjectStore.setState({ currentProject: { ...project, novelConfig: { ...project.novelConfig, totalChapters } } })
    await runAutomation()
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(useOutlineAutomation.getState().error).toBe(true)
  })
})
