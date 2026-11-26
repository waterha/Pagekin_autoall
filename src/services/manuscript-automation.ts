import { create } from 'zustand'
import { displayedErrorMessage } from '../i18n/app-errors'
import { AutomationWorkflowFailure, createAutomationRetryWaiter, isAutomationNetworkFailure } from './automation-network-retry'
import { localize } from '../i18n/core'
import type { AllInvokeChannels, ProjectSessionContext } from '../shared/ipc-channels'
import { sameProjectPathKey, sameProjectSessionContext } from '../shared/project-session-context'
import { countDraftUnits } from '../shared/draft-units'
import { parseChapterGoalReview } from '../shared/chapter-goal-review'
import { describeFinalizationStepError, planFinalizationRetry } from '../shared/finalization-step-error'
import { isOpenReopenDraft } from '../shared/chapter-reopen'
import { createHumanConfirmedReviewSnapshot, serializeHumanConfirmedReviewSnapshot, type HumanConfirmedReviewItem } from '../shared/human-confirmed-review'
import { captureProjectSession, isProjectSessionCurrent } from '../components/project-session-gate'
import { useProjectStore } from '../stores/project-store'
import { useLocaleStore } from '../stores/locale-store'
import { useLLMStore } from '../stores/llm-store'
import { useEditorStore } from '../stores/editor-store'
import { useDraftStore } from '../stores/draft-store'
import { useWorkflowStore, type WorkflowDefinition } from '../stores/workflow-store'
import { routeStageModel } from '../shared/model-stage-routing'
import { randomUUID } from '../utils/id'
import { ipc } from './ipc-client'
import { requireIpcSuccess } from './ipc-result'
import { readWritableChapters } from './authoritative-chapter-sequence'
import { guardChapterWriting } from './workflow-guards'
import { captureFinalizationSnapshot } from './finalization-snapshot'
import { preferredGenerationModelId, chapterDefaultWordsTarget } from './workflows/chapter-write-launch'
import { createChapterWorkflow, createReviewOnlyWorkflow, createRefineFromReviewWorkflow, createFinalizeWorkflow, createRepairFinalizeWorkflow } from './workflows/chapter-workflow'

type Phase = 'preparing' | 'writing' | 'reviewing' | 'revising' | 'merging' | 'rechecking' | 'finalizing' | 'retrying'
const MAX_POST_PROCESS_RETRIES = 3
interface AutomationState {
  session: ProjectSessionContext | null
  active: boolean
  stopping: boolean
  chapter: number | null
  phase: Phase
  retryAttempt: number
  networkRetryWaiting: boolean
  message: string
  error: boolean
}

/** A mode belongs to one open-book lease and survives navigation between pages. */
export const useManuscriptAutomation = create<AutomationState>(() => ({
  session: null, active: false, stopping: false, chapter: null, phase: 'preparing', retryAttempt: 0, networkRetryWaiting: false, message: '', error: false,
}))

const networkRetry = createAutomationRetryWaiter()
let activeRunId: string | undefined
class AutomationStopped extends Error {}
class ManuscriptEdited extends Error {}

export function stopManuscriptAutomation(): void {
  if (!useManuscriptAutomation.getState().active) return
  useManuscriptAutomation.setState({ stopping: true })
  networkRetry.cancel()
  if (activeRunId) useWorkflowStore.getState().cancelWorkflow(activeRunId)
}

type Draft = NonNullable<AllInvokeChannels['db:draft-get-full']['return']>

/** The button is the author's standing authorization to apply every issue in this mode. */
export async function startManuscriptAutomation(): Promise<void> {
  if (useManuscriptAutomation.getState().active) return
  const project = useProjectStore.getState().currentProject
  const session = captureProjectSession(project)
  if (!project || !session) return
  const locale = useLocaleStore.getState().locale
  const text = (zh: string, en: string) => localize(locale, zh, en)
  const path = session.projectPath
  useManuscriptAutomation.setState({ session, active: true, stopping: false, chapter: null, phase: 'preparing', retryAttempt: 0, networkRetryWaiting: false, message: '', error: false })

  const check = () => {
    if (useManuscriptAutomation.getState().stopping || !isProjectSessionCurrent(session)) throw new AutomationStopped()
  }
  // Check both sides of every await: reopening the same directory must also stop the old mode.
  const invoke: typeof ipc.invokeWithProjectSession = async (owner, channel, ...args) => {
    check()
    const result = await ipc.invokeWithProjectSession(owner, channel, ...args)
    check()
    return result
  }
  const phase = (value: Phase) => { check(); useManuscriptAutomation.setState({ phase: value, message: '' }) }
  const draftTabs = (draft: Draft) => useEditorStore.getState().tabs.filter(tab => tab.type === 'chapter'
      && sameProjectPathKey(tab.projectKey, path) && (tab.draftId === draft.id || tab.filePath === `ai-novel://draft/${draft.id}`))
  const assertEditorUnchanged = (draft: Draft) => {
    const tabs = draftTabs(draft)
    if (tabs.some(tab => tab.dirty || tab.finalizationConflict || tab.content !== draft.content)) {
      throw new ManuscriptEdited()
    }
    return tabs
  }
  const waitForNetwork = async (error: unknown, attempt: number) => {
    useManuscriptAutomation.setState({ networkRetryWaiting: true })
    try {
      await networkRetry.wait({ check, stopped: () => new AutomationStopped(), locale, error, attempt,
        update: message => useManuscriptAutomation.setState({ message }) })
    } finally { useManuscriptAutomation.setState({ networkRetryWaiting: false, message: '' }) }
  }
  const run = async (definition: WorkflowDefinition): Promise<Record<string, unknown>> => {
    let retry = 0
    for (;;) {
      check()
      const runId = randomUUID()
      let data: Record<string, unknown> = {}
      // Retry only the failed workflow; committed earlier phases are never replayed.
      const workflow = { ...definition, runId, uiLocale: locale, onComplete: { mode: 'silent' as const },
        steps: definition.steps.map(step => ({ ...step, executor: async (...args: Parameters<typeof step.executor>) => {
          args[1].data.automationNetworkRetry = true
          const result = await step.executor(...args)
          data = { ...args[1].data }
          return result
        } })),
      }
      activeRunId = runId
      try {
        await useWorkflowStore.getState().startWorkflow(workflow, false)
        check()
        const completed = useWorkflowStore.getState().history.find(item => item.id === runId)
        if (completed?.status === 'cancelled') throw new AutomationStopped()
        if (completed?.status !== 'completed') throw completed ? new AutomationWorkflowFailure(completed, locale)
          : new Error(text('正文自动化步骤未完成，已停止。', 'The automation step did not complete. Automation stopped.'))
        return data
      } catch (error) {
        check()
        // Finalization must first reconcile its durable commit and failed post-processing steps.
        if (['finalizing', 'retrying'].includes(useManuscriptAutomation.getState().phase) || !isAutomationNetworkFailure(error)) throw error
        activeRunId = undefined
        await waitForNetwork(error, ++retry)
      } finally { activeRunId = undefined }
    }
  }
  const readDraft = async (id: number): Promise<Draft> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const draft = await invoke(session, 'db:draft-get-full', id, path)
      if (!draft || !['draft', 'reviewed', 'revised'].includes(draft.status)) {
        throw new Error(text('找不到可继续处理的正文草稿，自动化已停止。', 'No editable manuscript draft was found. Automation stopped.'))
      }
      const tabs = draftTabs(draft)
      const changed = tabs.filter(tab => tab.dirty || tab.finalizationConflict || tab.content !== draft.content)
      if (!changed.length) {
        if (!draft.content.trim()) throw new Error(text('正文为空，无法继续自动化。', 'The manuscript is empty. Automation cannot continue.'))
        return draft
      }
      const content = changed[0].content ?? draft.content
      if (tabs.some(tab => (tab.content ?? draft.content) !== content)) {
        throw new Error(text('同一正文的多个标签内容不同，已保留所有修改，请先合并这些内容。', 'Multiple tabs contain different edits to this draft. All edits were preserved; merge them first.'))
      }
      const snapshots = tabs.map(tab => ({ tab, snapshot: { content, contentRevision: tab.contentRevision ?? 0 } }))
      // Use the same persistence command and snapshot settlement as the editor's Save action.
      requireIpcSuccess(await invoke(session, 'db:draft-update-content', id, content, countDraftUnits(content), path),
        text('自动保存正文', 'Automatically save manuscript'))
      const saved = await invoke(session, 'db:draft-get-full', id, path)
      if (saved?.content !== content || !['draft', 'reviewed', 'revised'].includes(saved.status)) {
        throw new Error(text('自动保存后正文状态发生变化，修改已保留，请检查后继续。', 'The draft changed after saving. Edits were preserved; check it before continuing.'))
      }
      for (const { tab, snapshot } of snapshots) {
        useEditorStore.getState().settleTabSave(tab.id, snapshot)
        useEditorStore.setState(state => ({ tabs: state.tabs.map(item => item.id === tab.id && !item.dirty
          && item.content === content && sameProjectPathKey(item.projectKey, path)
          ? { ...item, draftStatus: saved.status, finalizationConflict: undefined } : item) }))
      }
      if (!content.trim()) throw new Error(text('正文为空，已保存修改，无法继续自动化。', 'The manuscript is empty. Edits were saved; automation cannot continue.'))
      try { assertEditorUnchanged(saved); return saved } catch (error) {
        if (!(error instanceof ManuscriptEdited)) throw error
        // A keystroke during saving remains dirty and is saved again before AI continues.
      }
    }
    throw new Error(text('正文在自动保存期间持续变化，修改已保留，请暂停编辑后重试。', 'The manuscript kept changing during automatic saving. Edits were preserved; pause editing and try again.'))
  }
  const recoveredChapters = new Set<number>()
  const recoverFinalizationConflicts = async (onlyDraftId?: number) => {
    const reopenedNow = new Set<number>()
    const conflicts = useEditorStore.getState().tabs.filter(tab => tab.type === 'chapter' && tab.finalizationConflict
      && sameProjectPathKey(tab.projectKey, path))
    for (const candidate of conflicts) {
      const tab = useEditorStore.getState().tabs.find(item => item.id === candidate.id)
      if (!tab?.finalizationConflict) continue
      const id = tab.draftId ?? Number(/^ai-novel:\/\/draft\/(\d+)$/.exec(tab.filePath ?? '')?.[1])
      if (onlyDraftId !== undefined && id !== onlyDraftId) continue
      const draft = await invoke(session, 'db:draft-get-full', id, path)
      if (!draft) throw new Error(text('冲突正文不存在，已保留本地修改。', 'The conflicting draft was not found. Local edits were preserved.'))
      if (draft.status !== 'finalized') { await readDraft(id); continue }
      const tabs = draftTabs(draft)
      if (tabs.every(item => item.content === draft.content)) {
        useEditorStore.setState(state => ({ tabs: state.tabs.map(item => tabs.some(target => target.id === item.id)
          ? { ...item, dirty: false, savedContent: draft.content, draftStatus: 'finalized', finalizationConflict: undefined } : item) }))
        continue
      }
      // A committed final is immutable: preserve later edits in the normal reopened working draft.
      const reopened = requireIpcSuccess(await invoke(session, 'chapter:reopen', { chapterNumber: draft.chapterNumber }, path),
        text('自动保留定稿后的修改', 'Automatically preserve edits after finalization'))
      if (!reopened.success) throw new Error(reopened.error)
      const targets = draftTabs(draft)
      useEditorStore.setState(state => ({ tabs: state.tabs.map(item => targets.some(target => target.id === item.id)
        ? { ...item, draftId: reopened.draftId, filePath: `ai-novel://draft/${reopened.draftId}`,
          draftStatus: 'draft', projectSessionLease: session.leaseId, finalizationId: undefined,
          finalizationPublication: undefined } : item) }))
      await readDraft(reopened.draftId)
      recoveredChapters.add(draft.chapterNumber)
      reopenedNow.add(draft.chapterNumber)
    }
    return reopenedNow
  }
  const reviewDefinition = (draft: Draft, title: string) => createReviewOnlyWorkflow({
    openResult: false,
    projectPath: path, chapterNumber: draft.chapterNumber, chapterTitle: title,
    draftPath: `ai-novel://draft/${draft.id}`, draftContent: draft.content,
    sourceDraft: { id: draft.id, chapterNumber: draft.chapterNumber, version: draft.version,
      status: draft.status as 'draft' | 'revised' | 'reviewed', contentRevision: 0 },
  }, session)

  const repairPostProcessing = async (draftId: number, chapter: number, expectedContent?: string, initialFailure?: unknown): Promise<boolean> => {
    // Resolve through current finalized authority, then pin the exact finalization for every retry.
    const postRun = await invoke(session, 'db:post-process-get-latest-run', 'chapter_finalize', String(chapter), path)
    if (!postRun) return false
    let steps = await invoke(session, 'db:post-process-get-steps', postRun.id, path)
    const unfinished = () => {
      const plan = planFinalizationRetry(Object.fromEntries(steps.map(step => [step.stepKey, { ok: step.ok, error: step.errorMsg }])))
      return { plan, failed: steps.filter(step => !step.ok && !plan.retired.has(step.stepKey)) }
    }
    if (!unfinished().failed.length) return false
    const failureDetails = () => unfinished().failed.map(step => `${step.label}：${displayedErrorMessage(locale,
      describeFinalizationStepError(step.errorMsg || text('未完成，未记录具体原因。', 'Incomplete; no specific cause was recorded.'), text))}`).join('\n')
    let lastFailure: unknown = initialFailure
    let networkAttempts = 0
    const source = await invoke(session, 'db:continuity-read-source', draftId, path)
    if (source.status !== 'valid' || source.snapshot.source.chapterNumber !== chapter
      || (expectedContent !== undefined && source.snapshot.content !== expectedContent)
      || postRun.triggerSourceId !== `finalization:${source.snapshot.source.finalizationId}`) {
      throw new Error(text('定稿后处理来源已变化，正文自动化已停止。', 'The finalized post-processing source changed. Automation stopped.'))
    }
    const assertSource = async () => {
      const current = await invoke(session, 'db:continuity-read-source', draftId, path)
      const authoritative = await invoke(session, 'db:draft-get-finalized', chapter, path)
      if (current.status !== 'valid' || authoritative?.id !== draftId
        || current.snapshot.source.finalizationId !== source.snapshot.source.finalizationId
        || current.snapshot.source.contentHash !== source.snapshot.source.contentHash
        || current.snapshot.content !== source.snapshot.content) {
        throw new Error(text('定稿后处理来源已变化，正文自动化已停止。', 'The finalized post-processing source changed. Automation stopped.'))
      }
    }
    for (let attempt = 1; attempt <= MAX_POST_PROCESS_RETRIES;) {
      check()
      const { plan, failed } = unfinished()
      if (!failed.length) return true
      if (!plan.card.length) throw new Error(text(
        `定稿后处理有无法自动重试的步骤：${failed.map(step => step.label).join('、')}。请按后处理页面的说明处理。\n${failureDetails()}`,
        `Some post-finalization steps cannot be retried automatically: ${failed.map(step => step.label).join(', ')}. Follow the notes on the post-processing page.\n${failureDetails()}`))
      const networkFailed = isAutomationNetworkFailure(lastFailure)
        || !(lastFailure instanceof AutomationWorkflowFailure && lastFailure.blocked) && failed.some(step => isAutomationNetworkFailure(step.errorMsg))
      if (networkFailed) await waitForNetwork(lastFailure || failureDetails(), ++networkAttempts)
      await assertSource()
      phase('retrying')
      useManuscriptAutomation.setState({ retryAttempt: attempt, message: [failureDetails(), lastFailure ? displayedErrorMessage(locale, lastFailure) : ''].filter(Boolean).join('\n') })
      lastFailure = undefined
      try {
        // This is the same action as the chapter card's Retry failed steps button.
        await run(createRepairFinalizeWorkflow(chapter, path, session, undefined, source.snapshot.source))
      } catch (error) {
        check()
        if (error instanceof AutomationStopped) throw error
        lastFailure = error
        // The durable step results decide whether another retry is useful.
      }
      await assertSource()
      const latest = await invoke(session, 'db:post-process-get-latest-run', 'chapter_finalize', String(chapter), path)
      if (latest?.id !== postRun.id) throw new Error(text('定稿后处理记录已变化，正文自动化已停止。', 'The post-processing record changed. Automation stopped.'))
      steps = await invoke(session, 'db:post-process-get-steps', postRun.id, path)
      if (!isAutomationNetworkFailure(lastFailure)
        && (lastFailure instanceof AutomationWorkflowFailure && lastFailure.blocked || !unfinished().failed.some(step => isAutomationNetworkFailure(step.errorMsg)))) attempt++
    }
    const { failed } = unfinished()
    if (failed.length) throw new Error(text(
      `定稿后处理自动重试 ${MAX_POST_PROCESS_RETRIES} 轮仍未完成：${failed.map(step => step.label).join('、')}。已定稿正文和成功步骤已保留，请检查后重新开启正文自动化。\n${failureDetails()}${lastFailure ? `\n${displayedErrorMessage(locale, lastFailure)}` : ''}`,
      `Post-processing is still incomplete after ${MAX_POST_PROCESS_RETRIES} automatic retries: ${failed.map(step => step.label).join(', ')}. Finalized text and successful steps were preserved. Check the failure before restarting automation.\n${failureDetails()}${lastFailure ? `\n${displayedErrorMessage(locale, lastFailure)}` : ''}`))
    return true
  }

  try {
    const llm = useLLMStore.getState()
    const modelId = preferredGenerationModelId(llm.models, routeStageModel('drafting', llm).modelId)
    if (!modelId) throw new Error(text('请先在设置中配置可用于文本生成的模型。', 'Configure a text generation model in Settings first.'))
    const revisionModelId = preferredGenerationModelId(llm.models, routeStageModel('refinement', llm).modelId) ?? modelId
    const wordsTarget = chapterDefaultWordsTarget(project.novelConfig.wordsPerChapter)
    await recoverFinalizationConflicts()
    const chapters = await readWritableChapters(session, locale)
    check()
    // A previous run may have finalized its text before stopping on post-processing.
    // Repair those chapters before the authority's next writable chapter can skip them.
    const allDrafts = await invoke(session, 'db:draft-list-all', path)
    for (const draft of allDrafts) if (isOpenReopenDraft(draft)) recoveredChapters.add(draft.chapterNumber)
    const finalized = allDrafts.filter(draft => draft.status === 'finalized')
      .sort((a, b) => a.chapterNumber - b.chapterNumber)
    for (const draft of finalized) {
      useManuscriptAutomation.setState({ chapter: draft.chapterNumber })
      await repairPostProcessing(draft.id, draft.chapterNumber)
    }
    useManuscriptAutomation.setState({ message: '' })
    let chapter = recoveredChapters.size ? Math.min(...recoveredChapters) : chapters.writable[0]
    let processed = 0
    let editRestarts = 0
    while (chapter !== undefined) {
      check()
      useManuscriptAutomation.setState({ chapter })
      phase('preparing')
      const blueprint = await invoke(session, 'db:blueprint-get', chapter, path)
      if (!blueprint) {
        useManuscriptAutomation.setState({ message: processed > 0
          ? text(`已完成 ${processed} 章；第 ${chapter} 章尚无蓝图，正文自动化已结束。`, `Completed ${processed} chapters. Chapter ${chapter} has no blueprint; automation finished.`)
          : text(`第 ${chapter} 章尚无蓝图，请先生成章节蓝图。`, `Chapter ${chapter} has no blueprint. Generate its blueprint first.`) })
        break
      }
      const guard = await guardChapterWriting(chapter, path, session, locale)
      check()
      if (!guard.ok) throw new Error(guard.message)
      let generatedRevisionId: number | undefined
      try {
        const drafts = await invoke(session, 'db:draft-list', chapter, path)
        // Archived and superseded versions are history; continue only the latest live draft.
        const latest = drafts.filter(item => ['draft', 'reviewed', 'revised'].includes(item.status))
          .sort((a, b) => b.version - a.version)[0]
        if (drafts.some(item => item.status === 'finalized') && !recoveredChapters.has(chapter)) throw new Error(text('本章已定稿，请刷新项目后重新开启自动化。', 'This chapter is already finalized. Refresh the book before restarting automation.'))
        let draft: Draft
        const title = blueprint.title || text(`第 ${chapter} 章`, `Chapter ${chapter}`)
        if (latest) {
          draft = await readDraft(latest.id)
        } else {
          phase('writing')
          const generated = await run(createChapterWorkflow({
            projectPath: path, chapterNumber: chapter, title, role: blueprint.role,
            purpose: blueprint.purpose, characters: blueprint.characters, keyEvents: blueprint.keyEvents,
            suspenseHook: blueprint.suspenseHook, userGuidance: blueprint.userGuidance, wordsTarget,
          }, session, { generationModelId: modelId, uiLocale: locale }))
          draft = await readDraft(Number(generated.draftId))
        }
        const pending = await invoke(session, 'db:revision-get-pending', draft.id, path)
        if (pending.length > 0) throw new Error(text('本章还有待合并的修稿，请先合并或丢弃，再开启正文自动化。', 'This chapter has a pending revision. Merge or discard it before starting automation.'))
        phase('reviewing')
        const reviewed = await run(reviewDefinition(draft, title))
        const review = await invoke(session, 'db:review-get-full', Number(reviewed.reviewId), path)
        if (!review?.sourceDraft || review.baseDraftId !== draft.id || review.sourceDraft.content !== draft.content) throw new Error(text('审稿来源已变化，正文自动化已停止。', 'The review source changed. Automation stopped.'))
        const cycle = await invoke(session, 'db:review-cycle-get', review.id, path)
        const report = JSON.parse(review.content) as { summary: string; items: HumanConfirmedReviewItem[]; goalReview?: unknown }
        const snapshot = createHumanConfirmedReviewSnapshot({
          sourceReviewId: review.id, sourceDraft: review.sourceDraft, summary: report.summary,
          authorGuidance: '', ...(cycle ? { cycleId: cycle.cycleId } : {}),
          ...(report.goalReview ? { goalReview: parseChapterGoalReview(report.goalReview) ?? undefined } : {}),
          items: report.items.map((item, index) => ({ ...item, origin: 'ai',
            decision: item.severity === 'pass' ? 'ignore' : 'apply',
            ...(cycle?.findings.find(finding => finding.reviewItemIndex === index)?.findingId
              ? { findingId: cycle.findings.find(finding => finding.reviewItemIndex === index)!.findingId } : {}),
          })),
        })
        if (!snapshot) throw new Error(text('审稿清单无效，正文自动化已停止。', 'The review checklist is invalid. Automation stopped.'))
        const content = serializeHumanConfirmedReviewSnapshot(snapshot)
        assertEditorUnchanged(draft)
        const confirmation = requireIpcSuccess(await invoke(session, 'db:review-create', {
          baseDraftId: draft.id, content, expectedSource: review.sourceDraft,
          ...(cycle ? { reviewCycleId: cycle.cycleId } : {}),
        }, path), text('自动采纳审稿清单', 'Automatically accept review checklist'))
        if (snapshot.items.some(item => item.decision === 'apply')) {
          phase('revising')
          const revised = await run(createRefineFromReviewWorkflow({
            openResult: false,
            projectPath: path, chapterNumber: chapter, chapterTitle: title,
            draftPath: `ai-novel://draft/${draft.id}`, draftContent: draft.content,
            confirmedReviewContent: content, reviewSourceId: confirmation.id, generationModelId: revisionModelId,
          }, session))
          const revision = await invoke(session, 'db:revision-get-full', Number(revised.revisionId), path)
          if (!revision || revision.baseDraftId !== draft.id || revision.status !== 'pending') throw new Error(text('修稿没有返回可合并版本，正文自动化已停止。', 'The revision did not return a mergeable version. Automation stopped.'))
          generatedRevisionId = revision.id
          phase('merging')
          const tabs = assertEditorUnchanged(draft)
          check()
          const merged = requireIpcSuccess(await ipc.invokeWithProjectSession(session, 'db:revision-merge', {
            revisionId: revision.id, targetDraftId: draft.id, expectedDraftContent: draft.content,
            mergedContent: revision.content, wordCount: countDraftUnits(revision.content),
          }, path), text('自动合并修稿', 'Automatically merge revision'))
          if (!isProjectSessionCurrent(session)) throw new AutomationStopped()
          generatedRevisionId = undefined
          for (const tab of tabs) useEditorStore.getState().settleMergedRevision(tab.id,
            { content: draft.content, contentRevision: tab.contentRevision ?? 0 }, revision.content)
          draft = await readDraft(draft.id)
          if (draft.content !== revision.content) throw new ManuscriptEdited()
          if (merged.receipt?.reviewCycle?.disposition === 'required') {
            phase('rechecking')
            await run(createReviewOnlyWorkflow({
              openResult: false,
              projectPath: path, chapterNumber: chapter, chapterTitle: title,
              draftPath: `ai-novel://draft/${draft.id}`, draftContent: draft.content,
              sourceDraft: { id: draft.id, chapterNumber: chapter, version: draft.version, status: 'revised', contentRevision: 0 },
              reviewCycleId: merged.receipt.reviewCycle.cycleId, expectedMergedHash: merged.receipt.reviewCycle.mergedHash,
            }, session))
          }
        }
        phase('finalizing')
        const beforeSave = draft.content
        draft = await readDraft(draft.id)
        if (draft.content !== beforeSave) throw new ManuscriptEdited()
        const tab = assertEditorUnchanged(draft)[0]
        const snapshotTab = tab ? { ...tab, draftId: draft.id, chapterNumber: chapter, projectSessionLease: session.leaseId } : undefined
        if (snapshotTab) useEditorStore.setState(state => ({ tabs: state.tabs.map(item => item.id === snapshotTab.id ? snapshotTab : item) }))
        try {
          await run(createFinalizeWorkflow({ projectPath: path, chapterNumber: chapter, chapterTitle: title,
            draftPath: `ai-novel://draft/${draft.id}`, draftContent: draft.content,
            stopOnPostProcessFailure: true, eventSource: 'batch',
            ...(snapshotTab ? { snapshot: captureFinalizationSnapshot({ tab: snapshotTab, projectSession: session, chapterTitle: title }) } : {}),
          }, session))
        } catch (error) {
          check()
          if (error instanceof AutomationStopped) throw error
          const committed = await invoke(session, 'db:draft-get-full', draft.id, path)
          if (committed?.status !== 'finalized' || committed.content !== draft.content
            || !await repairPostProcessing(draft.id, chapter, draft.content, error)) throw error
        }
        if ((await recoverFinalizationConflicts(draft.id)).has(chapter)) {
          if (++editRestarts >= 3) throw new Error(text('定稿期间正文持续变化，修改已保存，请暂停编辑后重试。', 'The manuscript kept changing during finalization. Edits were saved; pause editing and try again.'))
          continue
        }
        useManuscriptAutomation.setState({ message: '' })
        await useDraftStore.getState().loadChapterDrafts(chapter, path, session)
        check()
        const authority = await readWritableChapters(session, locale)
        check()
        const recovered = recoveredChapters.delete(chapter)
        if (!recovered && !authority.writable.includes(chapter + 1)) throw new Error(text('下一章暂不可写，正文自动化已停止。', 'The next chapter is not writable yet. Automation stopped.'))
        processed++
        editRestarts = 0
        chapter = recoveredChapters.size ? Math.min(...recoveredChapters) : recovered ? authority.writable[0] : chapter + 1
      } catch (error) {
        if (!(error instanceof ManuscriptEdited)) throw error
        if (generatedRevisionId !== undefined) requireIpcSuccess(await invoke(session, 'db:revision-mark-discarded', generatedRevisionId, path),
          text('丢弃基于旧正文生成的自动修稿', 'Discard automatic revision based on earlier text'))
        if (++editRestarts >= 3) throw new Error(text('正文在自动化期间持续变化，修改已保留，请暂停编辑后重试。', 'The manuscript kept changing during automation. Edits were preserved; pause editing and try again.'))
        // Saving changes invalidates the old review; restart this chapter with the saved source.
        const latest = (await invoke(session, 'db:draft-list', chapter, path))
          .filter(item => ['draft', 'reviewed', 'revised'].includes(item.status)).sort((a, b) => b.version - a.version)[0]
        if (latest) await readDraft(latest.id)
      }
    }
  } catch (error) {
    useManuscriptAutomation.setState({ error: !(error instanceof AutomationStopped), message: error instanceof AutomationStopped
      ? text('正文自动化已停止，已生成的内容已保留。', 'Automation stopped. Generated content was preserved.')
      : text(`第 ${useManuscriptAutomation.getState().chapter ?? '—'} 章 · ${displayedErrorMessage(locale, error)}`, `Chapter ${useManuscriptAutomation.getState().chapter ?? '—'} · ${displayedErrorMessage(locale, error)}`) })
  } finally {
    activeRunId = undefined
    // Never allow an old lease's completion to change a newer mode.
    if (sameProjectSessionContext(useManuscriptAutomation.getState().session, session)) {
      useManuscriptAutomation.setState({ active: false, stopping: false, networkRetryWaiting: false })
    }
  }
}
