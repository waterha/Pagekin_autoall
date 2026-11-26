import { create } from 'zustand'
import { displayedErrorMessage } from '../i18n/app-errors'
import { AutomationWorkflowFailure, createAutomationRetryWaiter, isAutomationNetworkFailure } from './automation-network-retry'
import { localize } from '../i18n/core'
import type { ProjectSessionContext } from '../shared/ipc-channels'
import { sameProjectPathKey, sameProjectSessionContext } from '../shared/project-session-context'
import { parsePlanningTargetUnits } from '../shared/plot-outline-contract'
import { routeStageModel } from '../shared/model-stage-routing'
import { captureProjectSession, isProjectSessionCurrent } from '../components/project-session-gate'
import { CHAPTER_CARD_TAB_ID, parseChapterCardDraftLedger } from '../components/editor/chapter-card-draft-ledger'
import { useProjectStore } from '../stores/project-store'
import { useLocaleStore } from '../stores/locale-store'
import { useLLMStore } from '../stores/llm-store'
import { useEditorStore } from '../stores/editor-store'
import { useWorkflowStore } from '../stores/workflow-store'
import { randomUUID } from '../utils/id'
import { ipc } from './ipc-client'
import { readWritableChapters } from './authoritative-chapter-sequence'
import { guardDirectoryGeneration } from './workflow-guards'
import { preferredGenerationModelId } from './workflows/chapter-write-launch'
import { createDirectoryWorkflow } from './workflows/directory-workflow'

interface BlueprintAutomationState {
  session: ProjectSessionContext | null
  active: boolean
  stopping: boolean
  startChapter: number | null
  endChapter: number | null
  total: number
  message: string
  error: boolean
  networkRetryWaiting: boolean
}

export const useBlueprintAutomation = create<BlueprintAutomationState>(() => ({
  session: null, active: false, stopping: false, startChapter: null, endChapter: null,
  total: 0, message: '', error: false, networkRetryWaiting: false,
}))

const networkRetry = createAutomationRetryWaiter()
let activeRunId: string | undefined
class AutomationStopped extends Error {}

export function stopBlueprintAutomation(): void {
  if (!useBlueprintAutomation.getState().active) return
  useBlueprintAutomation.setState({ stopping: true })
  networkRetry.cancel()
  if (activeRunId) useWorkflowStore.getState().cancelWorkflow(activeRunId)
}

/** Orchestrate the existing planner; each completed batch is durably saved before continuing. */
export async function startBlueprintAutomation(): Promise<void> {
  if (useBlueprintAutomation.getState().active) return
  const project = useProjectStore.getState().currentProject
  const session = captureProjectSession(project)
  if (!project || !session) return
  const locale = useLocaleStore.getState().locale
  const text = (zh: string, en: string) => localize(locale, zh, en)
  const path = session.projectPath
  const total = project.novelConfig.totalChapters
  useBlueprintAutomation.setState({ session, active: true, stopping: false, startChapter: null,
    endChapter: null, total, message: '', error: false, networkRetryWaiting: false })
  const check = () => {
    if (useBlueprintAutomation.getState().stopping || !isProjectSessionCurrent(session)) throw new AutomationStopped()
    if (useProjectStore.getState().currentProject?.novelConfig.totalChapters !== total) {
      throw new Error(text('作品总章数已变化，请重新开启蓝图自动化。', 'The chapter total changed. Restart blueprint automation.'))
    }
    const ledger = parseChapterCardDraftLedger(useEditorStore.getState().draftLedgers[CHAPTER_CARD_TAB_ID])
    if (ledger.projects.some(draft => sameProjectPathKey(draft.projectKey, path) && draft.dirtyChapterNumbers.length > 0)) {
      throw new Error(text('蓝图有未保存的修改，请先保存，再开启蓝图自动化。', 'Blueprints have unsaved edits. Save them before starting blueprint automation.'))
    }
  }
  const invoke: typeof ipc.invokeWithProjectSession = async (owner, channel, ...args) => {
    check()
    const result = await ipc.invokeWithProjectSession(owner, channel, ...args)
    check()
    return result
  }

  try {
    check()
    if (!Number.isSafeInteger(total) || total < 1) throw new Error(text('请先设置有效的作品总章数。', 'Set a valid chapter total first.'))
    let generationModelId: string | undefined
    let targetUnits: number | undefined
    let processed = 0
    let retries = 0
    for (;;) {
      try {
        check()
        const authority = await readWritableChapters(session, locale)
        check()
        const existing = await invoke(session, 'db:blueprint-get-all', path)
        const planned = new Set(existing.map(item => item.chapterNumber))
        // Append after finalized authority, filling only missing blueprints; never replace existing chapters.
        let start = authority.next
        while (start <= total && planned.has(start)) start++
        const pendingSyncs = await invoke(session, 'db:blueprint-character-sync-list-pending', path)
        if (pendingSyncs.length > 0) throw new Error(text('蓝图已保存，但还有未完成的角色同步。请先在蓝图页重试角色同步，再开启自动化。', 'Blueprints are saved, but character synchronization is pending. Retry it on the Blueprints page before starting automation.'))
        if (start > total) {
          useBlueprintAutomation.setState({ message: text(`蓝图规划已完成（共 ${total} 章，本次新增 ${processed} 章）。`, `Blueprint planning is complete (${total} chapters; ${processed} added this time).`) })
          break
        }
        let end = start
        while (end < total && end - start + 1 < 5 && !planned.has(end + 1)) end++
        useBlueprintAutomation.setState({ startChapter: start, endChapter: end })
        const guard = await guardDirectoryGeneration(path, session, locale)
        check()
        if (!guard.ok) throw new Error(guard.message)
        if (!generationModelId) {
          const llm = useLLMStore.getState()
          generationModelId = preferredGenerationModelId(llm.models, routeStageModel('planning', llm).modelId) ?? undefined
          if (!generationModelId) throw new Error(text('请先在设置中配置可用于文本生成的模型。', 'Configure a text generation model in Settings first.'))
          const config = await ipc.invoke('config:get')
          check()
          targetUnits = parsePlanningTargetUnits(config.blueprintTargetUnits)
        }
        const runId = randomUUID()
        const definition = createDirectoryWorkflow({ mode: 'append', startChapter: start, count: end - start + 1, targetUnits }, path, session, locale)
        check()
        activeRunId = runId
        try {
          await useWorkflowStore.getState().startWorkflow({ ...definition, runId, generationModelId }, false)
        } finally { activeRunId = undefined }
        check()
        const completed = useWorkflowStore.getState().history.find(item => item.id === runId)
        if (completed?.status === 'cancelled') throw new AutomationStopped()
        if (completed?.status !== 'completed') throw completed ? new AutomationWorkflowFailure(completed, locale) : new Error(text('本批蓝图规划未完成，自动化已停止。', 'This blueprint batch did not complete. Automation stopped.'))
        const saved = new Set((await invoke(session, 'db:blueprint-get-all', path)).map(item => item.chapterNumber))
        for (let chapter = start; chapter <= end; chapter++) {
          if (!saved.has(chapter)) throw new Error(text(`第 ${chapter} 章蓝图未保存，自动化已停止，请检查本批结果。`, `Chapter ${chapter}'s blueprint was not saved. Automation stopped; check this batch.`))
        }
        processed += end - start + 1
        retries = 0
      } catch (error) {
        check()
        if (!isAutomationNetworkFailure(error)) throw error
        useBlueprintAutomation.setState({ networkRetryWaiting: true })
        try {
          await networkRetry.wait({ check, stopped: () => new AutomationStopped(), locale, error, attempt: ++retries,
            update: message => useBlueprintAutomation.setState({ message }) })
        } finally { useBlueprintAutomation.setState({ networkRetryWaiting: false, message: '' }) }
        // Re-read saved blueprints before planning only the still-missing chapters.
      }
    }
  } catch (error) {
    useBlueprintAutomation.setState({ error: !(error instanceof AutomationStopped), message: error instanceof AutomationStopped
      ? text('蓝图自动化已停止，已保存的蓝图已保留。', 'Blueprint automation stopped. Saved blueprints were preserved.')
      : displayedErrorMessage(locale, error) })
  } finally {
    activeRunId = undefined
    if (sameProjectSessionContext(useBlueprintAutomation.getState().session, session)) {
      useBlueprintAutomation.setState({ active: false, stopping: false, networkRetryWaiting: false })
    }
  }
}
