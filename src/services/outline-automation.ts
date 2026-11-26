import { create } from 'zustand'
import { displayedErrorMessage } from '../i18n/app-errors'
import { AutomationWorkflowFailure, createAutomationRetryWaiter, isAutomationNetworkFailure } from './automation-network-retry'
import { localize } from '../i18n/core'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import { sameProjectSessionContext } from '../shared/project-session-context'
import type { MainGenerationRunHandle } from './generation/generation-runtime'
import { DEFAULT_PLANNING_ACTION_CHAPTERS, parsePlanningTargetUnits, plotOutlineLastChapter } from '../shared/plot-outline-contract'
import { outlineProgress } from '../shared/plot-outline-checkpoint'
import { architectureRecoveryHandle } from '../shared/architecture-recovery-navigation'
import { routeStageModel } from '../shared/model-stage-routing'
import { captureProjectSession, isProjectSessionCurrent } from '../components/project-session-gate'
import { useProjectStore } from '../stores/project-store'
import { useLocaleStore } from '../stores/locale-store'
import { useLLMStore } from '../stores/llm-store'
import { useWorkflowStore } from '../stores/workflow-store'
import { randomUUID } from '../utils/id'
import { ipc } from './ipc-client'
import { archOutlineSource, readArchCheckpointWithOutline } from './architecture-service'
import { guardArchitectureGeneration } from './workflow-guards'
import { preferredGenerationModelId } from './workflows/chapter-write-launch'
import { createArchitectureWorkflow } from './workflows/architecture-workflow'
import { OutlineRecoveryBlocked, recoverOutlineAutomation, saveOutlineAutomationEditors } from './outline-automation-recovery'

const MAX_RECOVERY_RETRIES = 3
const transientFailure = (error: unknown) => /NETWORK_ERROR|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EBUSY|SQLITE_BUSY|SQLITE_LOCKED|Failed to fetch|网络|超时|保存.*失败|save.*fail/i.test(String(error))

interface OutlineAutomationState {
  session: ProjectSessionContext | null
  active: boolean
  stopping: boolean
  startChapter: number | null
  endChapter: number | null
  total: number
  message: string
  error: boolean
  phase: 'generating' | 'saving' | 'recovering' | 'retrying'
}

export const useOutlineAutomation = create<OutlineAutomationState>(() => ({
  session: null, active: false, stopping: false, startChapter: null, endChapter: null,
  total: 0, message: '', error: false, phase: 'generating',
}))

let activeRunId: string | undefined
let retryController: AbortController | undefined
const networkRetry = createAutomationRetryWaiter()
class AutomationStopped extends Error {}

export function stopOutlineAutomation(): void {
  if (!useOutlineAutomation.getState().active) return
  useOutlineAutomation.setState({ stopping: true })
  retryController?.abort()
  networkRetry.cancel()
  if (activeRunId) useWorkflowStore.getState().cancelWorkflow(activeRunId)
}

/** Each batch uses the existing architecture workflow and must be saved before the next starts. */
export async function startOutlineAutomation(): Promise<void> {
  if (useOutlineAutomation.getState().active) return
  const project = useProjectStore.getState().currentProject
  const session = captureProjectSession(project)
  if (!project || !session) return
  const locale = useLocaleStore.getState().locale
  const text = (zh: string, en: string) => localize(locale, zh, en)
  const path = session.projectPath
  const total = project.novelConfig.totalChapters
  const settledHandles = new Set<string>()
  useOutlineAutomation.setState({ session, active: true, stopping: false, startChapter: null,
    endChapter: null, total, message: '', error: false, phase: 'generating' })
  const check = () => {
    if (useOutlineAutomation.getState().stopping || !isProjectSessionCurrent(session)) throw new AutomationStopped()
    if (useProjectStore.getState().currentProject?.novelConfig.totalChapters !== total) {
      throw new Error(text('作品总章数已变化，请重新开启大纲自动化。', 'The chapter total changed. Restart outline automation.'))
    }
  }
  const read = async () => {
    check()
    const core = await ipc.invokeWithProjectSession(session, 'db:project-core-get', path)
    check()
    const loaded = await readArchCheckpointWithOutline(session)
    const recorded = architectureRecoveryHandle(loaded.checkpoint, 'synopsis', session.projectId)
    // A lost navigation write can still point at a superseded run whose successor is already saved.
    // Trust the checked formal result without following that same obsolete chain forever.
    const checkpoint = recorded && settledHandles.has(recorded.runId)
      ? Object.fromEntries(Object.entries(loaded.checkpoint ?? {}).filter(([key]) => !key.startsWith('synopsis_')))
      : loaded.checkpoint
    const outline = loaded.outline
    check()
    const source = archOutlineSource(core, project.novelConfig)
    if (source.totalChapters !== total) throw new Error(text('作品总章数已变化，请重新开启大纲自动化。', 'The chapter total changed. Restart outline automation.'))
    return { core, checkpoint, outline, source, progress: outlineProgress(source.synopsis, checkpoint, source.writingLanguage, total) }
  }

  try {
    check()
    if (!Number.isSafeInteger(total) || total < 1) throw new Error(text('请先设置有效的作品总章数。', 'Set a valid chapter total first.'))
    let generationModelId: string | undefined
    let targetUnits: number | undefined
    let pendingHandle: MainGenerationRunHandle | undefined
    let retries = 0
    let networkRetries = 0
    for (;;) {
      try {
        useOutlineAutomation.setState({ phase: 'saving', message: text('正在检测并自动保存架构修改…', 'Checking and saving architecture edits…') })
        await saveOutlineAutomationEditors(session, check, text)
        check()
        const { core, checkpoint, outline, progress } = await read()
        const handle = pendingHandle ?? architectureRecoveryHandle(checkpoint, 'synopsis', session.projectId)
        let recoveryAction: Exclude<Awaited<ReturnType<typeof recoverOutlineAutomation>>, { kind: 'saved' }> | undefined
        if (handle) {
          pendingHandle = handle
          useOutlineAutomation.setState({ phase: 'recovering', message: text('正在检测恢复稿，保存完整章节并恢复生成…', 'Checking the recovery draft, saving complete chapters and resuming…') })
          const context = outline?.handle.runId === handle.runId ? outline
            : await ipc.invokeWithProjectSession(session, 'generation:read-context', { handle })
          check()
          const action = await recoverOutlineAutomation(session, context, check, text)
          check()
          if (action.kind === 'saved') { settledHandles.add(handle.runId); pendingHandle = undefined; continue }
          recoveryAction = action
        }
        // An unfinished batch owns its saved candidate, even when the formal outline is still empty.
        if ((!handle && checkpoint?.synopsis_incomplete === true) || progress.kind === 'unresumable') {
          throw new Error(text('大纲进度无法安全续写，请先在情节大纲中处理恢复稿或选择章节范围重新生成。', 'The outline cannot be continued safely. Resolve its recovery draft or choose a chapter range to regenerate first.'))
        }
        if (!handle && progress.kind === 'complete') {
          useOutlineAutomation.setState({ message: text(`情节大纲已全部完成（共 ${total} 章）。`, `The plot outline is complete (${total} chapters).`) })
          break
        }
        const from = recoveryAction?.range.from ?? (progress.kind === 'partial' ? progress.coveredTo + 1 : 1)
        const to = recoveryAction?.range.to ?? Math.min(total, from + DEFAULT_PLANNING_ACTION_CHAPTERS - 1)
        if (typeof from !== 'number' || typeof to !== 'number'
          || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to > total) {
          throw new Error(text('大纲检查点的章节范围无效，请先处理恢复稿。', 'The outline checkpoint has an invalid chapter range. Resolve its recovery draft first.'))
        }
        useOutlineAutomation.setState({ startChapter: from, endChapter: to, phase: 'generating', message: '' })
        const guard = guardArchitectureGeneration(path, session, locale)
        if (!guard.ok) throw new Error(guard.message)
        if (!core?.premise || !core.charactersArch || !core.worldbuilding) {
          throw new Error(text('请先完成故事前提、角色名单和世界观，再开启大纲自动化。', 'Complete the premise, characters and worldbuilding before starting outline automation.'))
        }
        if (!generationModelId) {
          const llm = useLLMStore.getState()
          generationModelId = preferredGenerationModelId(llm.models, routeStageModel('planning', llm).modelId) ?? undefined
          if (!generationModelId) throw new Error(text('请先在设置中配置可用于文本生成的模型。', 'Configure a text generation model in Settings first.'))
          const config = await ipc.invoke('config:get')
          check()
          targetUnits = parsePlanningTargetUnits(config.outlineTargetUnits)
        }
        const definition = createArchitectureWorkflow({ projectPath: path, projectSession: session,
          selectedSteps: ['synopsis'], targetUnits,
          ...(recoveryAction?.kind === 'resume' ? { resumeSynopsis: true, expectedRecoveryHandle: recoveryAction.handle, recoverMissingSynopsisNavigation: true }
            : { synopsisRange: { from, to }, ...(recoveryAction?.kind === 'restart'
              ? { restartFrom: recoveryAction.handle, targetUnits: recoveryAction.targetUnits } : {}) }),
        }, locale)
        check()
        const runId = randomUUID()
        activeRunId = runId
        try {
          await useWorkflowStore.getState().startWorkflow({ ...definition, runId, generationModelId,
            steps: definition.steps.map(step => ({ ...step, executor: async (...args: Parameters<typeof step.executor>) => {
              try { return await step.executor(...args) }
              finally {
                pendingHandle = args[1].mainGenerationRunHandle ?? architectureRecoveryHandle({
                  synopsis_incomplete: true, synopsis_generation_handle: args[1].data.synopsisGenerationHandle,
                }, 'synopsis', session.projectId) ?? pendingHandle
              }
            } })),
          }, false)
        } finally { activeRunId = undefined }
        check()
        const completed = useWorkflowStore.getState().history.find(item => item.id === runId)
        if (completed?.status === 'cancelled') throw new AutomationStopped()
        if (completed?.status !== 'completed') throw completed ? new AutomationWorkflowFailure(completed, locale) : new Error(text('本批大纲未完成，自动化已停止。', 'This outline batch did not complete. Automation stopped.'))
        const saved = await read()
        if (saved.checkpoint?.synopsis_incomplete === true
          || (saved.progress.kind !== 'partial' && saved.progress.kind !== 'complete')
          || (plotOutlineLastChapter(saved.source.synopsis) ?? 0) < to
          || saved.progress.kind === 'complete' && to < total) {
          throw new Error(text('本批大纲尚未完整保存，自动化已停止，请检查本批结果。', 'This outline batch has not been fully saved. Automation stopped; check this batch.'))
        }
        pendingHandle = undefined
        retries = 0
        networkRetries = 0
      } catch (error) {
        check()
        if (error instanceof AutomationStopped || error instanceof OutlineRecoveryBlocked) throw error
        if (isAutomationNetworkFailure(error)) {
          useOutlineAutomation.setState({ phase: 'retrying' })
          await networkRetry.wait({ check, stopped: () => new AutomationStopped(), locale, error, attempt: ++networkRetries,
            update: message => useOutlineAutomation.setState({ message }) })
          continue
        }
        if (error instanceof AutomationWorkflowFailure && error.blocked) throw error
        if (!pendingHandle) {
          try {
            const { checkpoint } = await read()
            pendingHandle = architectureRecoveryHandle(checkpoint, 'synopsis', session.projectId)
          } catch (readError) {
            check()
            if (!transientFailure(readError)) throw readError
          }
        }
        if (!pendingHandle && !transientFailure(error)) throw error
        if (retries >= MAX_RECOVERY_RETRIES) throw new Error(text(
          `已自动恢复重试 ${MAX_RECOVERY_RETRIES} 次仍未成功，已保留大纲和恢复稿。${displayedErrorMessage(locale, error)}`,
          `Automatic recovery failed after ${MAX_RECOVERY_RETRIES} retries. Outlines and recovery drafts were preserved. ${displayedErrorMessage(locale, error)}`))
        retries++
        useOutlineAutomation.setState({ phase: 'retrying', message: text(
          `检测到生成或保存中断，正在自动恢复并重试（${retries}/${MAX_RECOVERY_RETRIES}）…\n${displayedErrorMessage(locale, error)}`,
          `Generation or saving was interrupted. Automatically recovering and retrying (${retries}/${MAX_RECOVERY_RETRIES})…\n${displayedErrorMessage(locale, error)}`) })
        const controller = new AbortController()
        retryController = controller
        try {
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(timer); reject(new AutomationStopped()) }
            const timer = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve() }, 1000 * 2 ** (retries - 1))
            controller.signal.addEventListener('abort', abort, { once: true })
          })
        } finally { retryController = undefined }
        check()
      }
    }
  } catch (error) {
    useOutlineAutomation.setState({ error: !(error instanceof AutomationStopped), message: error instanceof AutomationStopped
      ? text('大纲自动化已停止，已保存的大纲和恢复稿已保留。', 'Outline automation stopped. Saved outlines and recovery drafts were preserved.')
      : displayedErrorMessage(locale, error) })
  } finally {
    activeRunId = undefined
    retryController = undefined
    if (sameProjectSessionContext(useOutlineAutomation.getState().session, session)) {
      useOutlineAutomation.setState({ active: false, stopping: false })
    }
  }
}
