import { create } from 'zustand'
import { displayedErrorMessage } from '../i18n/app-errors'
import { localize } from '../i18n/core'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import { sameProjectPathKey, sameProjectSessionContext } from '../shared/project-session-context'
import { DEFAULT_PLANNING_ACTION_CHAPTERS, parsePlanningTargetUnits, plotOutlineLastChapter } from '../shared/plot-outline-contract'
import { outlineProgress } from '../shared/plot-outline-checkpoint'
import { architectureRecoveryHandle } from '../shared/architecture-recovery-navigation'
import { routeStageModel } from '../shared/model-stage-routing'
import { captureProjectSession, isProjectSessionCurrent } from '../components/project-session-gate'
import { useProjectStore } from '../stores/project-store'
import { useLocaleStore } from '../stores/locale-store'
import { useLLMStore } from '../stores/llm-store'
import { useEditorStore } from '../stores/editor-store'
import { useWorkflowStore } from '../stores/workflow-store'
import { randomUUID } from '../utils/id'
import { ipc } from './ipc-client'
import { archOutlineSource, readArchCheckpointWithOutline } from './architecture-service'
import { guardArchitectureGeneration } from './workflow-guards'
import { preferredGenerationModelId } from './workflows/chapter-write-launch'
import { createArchitectureWorkflow } from './workflows/architecture-workflow'

interface OutlineAutomationState {
  session: ProjectSessionContext | null
  active: boolean
  stopping: boolean
  startChapter: number | null
  endChapter: number | null
  total: number
  message: string
  error: boolean
}

export const useOutlineAutomation = create<OutlineAutomationState>(() => ({
  session: null, active: false, stopping: false, startChapter: null, endChapter: null,
  total: 0, message: '', error: false,
}))

let activeRunId: string | undefined
class AutomationStopped extends Error {}

export function stopOutlineAutomation(): void {
  if (!useOutlineAutomation.getState().active) return
  useOutlineAutomation.setState({ stopping: true })
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
  useOutlineAutomation.setState({ session, active: true, stopping: false, startChapter: null,
    endChapter: null, total, message: '', error: false })
  const check = () => {
    if (useOutlineAutomation.getState().stopping || !isProjectSessionCurrent(session)) throw new AutomationStopped()
    if (useProjectStore.getState().currentProject?.novelConfig.totalChapters !== total) {
      throw new Error(text('作品总章数已变化，请重新开启大纲自动化。', 'The chapter total changed. Restart outline automation.'))
    }
    if (useEditorStore.getState().tabs.some(tab => tab.type === 'arch-file'
      && sameProjectPathKey(tab.projectKey, path)
      && (tab.dirty || tab.savedContent !== undefined && tab.content !== tab.savedContent))) {
      throw new Error(text('故事架构有未保存的修改，请先保存，再开启大纲自动化。', 'Story architecture has unsaved edits. Save them before starting outline automation.'))
    }
  }
  const read = async () => {
    check()
    const core = await ipc.invokeWithProjectSession(session, 'db:project-core-get', path)
    check()
    const { checkpoint } = await readArchCheckpointWithOutline(session)
    check()
    const source = archOutlineSource(core, project.novelConfig)
    if (source.totalChapters !== total) throw new Error(text('作品总章数已变化，请重新开启大纲自动化。', 'The chapter total changed. Restart outline automation.'))
    return { core, checkpoint, source, progress: outlineProgress(source.synopsis, checkpoint, source.writingLanguage, total) }
  }

  try {
    check()
    if (!Number.isSafeInteger(total) || total < 1) throw new Error(text('请先设置有效的作品总章数。', 'Set a valid chapter total first.'))
    let generationModelId: string | undefined
    let targetUnits: number | undefined
    for (;;) {
      const { core, checkpoint, progress } = await read()
      const handle = architectureRecoveryHandle(checkpoint, 'synopsis', session.projectId)
      // An unfinished batch owns its saved candidate, even when the formal outline is still empty.
      if ((!handle && checkpoint?.synopsis_incomplete === true) || progress.kind === 'unresumable') {
        throw new Error(text('大纲进度无法安全续写，请先在情节大纲中处理恢复稿或选择章节范围重新生成。', 'The outline cannot be continued safely. Resolve its recovery draft or choose a chapter range to regenerate first.'))
      }
      if (!handle && progress.kind === 'complete') {
        useOutlineAutomation.setState({ message: text(`情节大纲已全部完成（共 ${total} 章）。`, `The plot outline is complete (${total} chapters).`) })
        break
      }
      const from = handle ? (checkpoint?.synopsis_range as { from: number; to: number } | undefined)?.from
        : progress.kind === 'partial' ? progress.coveredTo + 1 : 1
      const to = handle ? (checkpoint?.synopsis_range as { from: number; to: number } | undefined)?.to
        : Math.min(total, (from ?? 1) + DEFAULT_PLANNING_ACTION_CHAPTERS - 1)
      if (typeof from !== 'number' || typeof to !== 'number'
        || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to > total) {
        throw new Error(text('大纲检查点的章节范围无效，请先处理恢复稿。', 'The outline checkpoint has an invalid chapter range. Resolve its recovery draft first.'))
      }
      useOutlineAutomation.setState({ startChapter: from, endChapter: to })
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
        ...(handle ? { resumeSynopsis: true, expectedRecoveryHandle: handle } : { synopsisRange: { from, to } }),
      }, locale)
      check()
      const runId = randomUUID()
      activeRunId = runId
      try {
        await useWorkflowStore.getState().startWorkflow({ ...definition, runId, generationModelId }, false)
      } finally { activeRunId = undefined }
      check()
      const completed = useWorkflowStore.getState().history.find(item => item.id === runId)
      if (completed?.status === 'cancelled') throw new AutomationStopped()
      if (completed?.status !== 'completed') throw new Error(completed?.error || text('本批大纲未完成，自动化已停止。', 'This outline batch did not complete. Automation stopped.'))
      const saved = await read()
      if (saved.checkpoint?.synopsis_incomplete === true
        || (saved.progress.kind !== 'partial' && saved.progress.kind !== 'complete')
        || (plotOutlineLastChapter(saved.source.synopsis) ?? 0) < to
        || saved.progress.kind === 'complete' && to < total) {
        throw new Error(text('本批大纲尚未完整保存，自动化已停止，请检查本批结果。', 'This outline batch has not been fully saved. Automation stopped; check this batch.'))
      }
    }
  } catch (error) {
    useOutlineAutomation.setState({ error: !(error instanceof AutomationStopped), message: error instanceof AutomationStopped
      ? text('大纲自动化已停止，已保存的大纲和恢复稿已保留。', 'Outline automation stopped. Saved outlines and recovery drafts were preserved.')
      : displayedErrorMessage(locale, error) })
  } finally {
    activeRunId = undefined
    if (sameProjectSessionContext(useOutlineAutomation.getState().session, session)) {
      useOutlineAutomation.setState({ active: false, stopping: false })
    }
  }
}
