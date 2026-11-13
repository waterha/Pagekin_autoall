import { create } from 'zustand'
import { displayedErrorMessage } from '../i18n/app-errors'
import { localize } from '../i18n/core'
import type { AllInvokeChannels, ProjectSessionContext } from '../shared/ipc-channels'
import { sameProjectPathKey, sameProjectSessionContext } from '../shared/project-session-context'
import { countDraftUnits } from '../shared/draft-units'
import { parseChapterGoalReview } from '../shared/chapter-goal-review'
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
import { createChapterWorkflow, createReviewOnlyWorkflow, createRefineFromReviewWorkflow, createFinalizeWorkflow } from './workflows/chapter-workflow'

type Phase = 'preparing' | 'writing' | 'reviewing' | 'revising' | 'merging' | 'rechecking' | 'finalizing'
interface AutomationState {
  session: ProjectSessionContext | null
  active: boolean
  stopping: boolean
  chapter: number | null
  phase: Phase
  message: string
  error: boolean
}

/** A mode belongs to one open-book lease and survives navigation between pages. */
export const useManuscriptAutomation = create<AutomationState>(() => ({
  session: null, active: false, stopping: false, chapter: null, phase: 'preparing', message: '', error: false,
}))

let activeRunId: string | undefined
class AutomationStopped extends Error {}

export function stopManuscriptAutomation(): void {
  if (!useManuscriptAutomation.getState().active) return
  useManuscriptAutomation.setState({ stopping: true })
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
  useManuscriptAutomation.setState({ session, active: true, stopping: false, chapter: null, phase: 'preparing', message: '', error: false })

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
  const phase = (value: Phase) => { check(); useManuscriptAutomation.setState({ phase: value }) }
  const assertEditorUnchanged = (draft: Draft) => {
    const tabs = useEditorStore.getState().tabs.filter(tab => tab.type === 'chapter'
      && sameProjectPathKey(tab.projectKey, path) && (tab.draftId === draft.id || tab.filePath === `ai-novel://draft/${draft.id}`))
    if (tabs.some(tab => tab.dirty || tab.finalizationConflict || tab.content !== draft.content)) {
      throw new Error(text('正文存在未保存的修改或定稿冲突，请处理后再开启正文自动化。', 'The manuscript has unsaved edits or a finalization conflict. Resolve them before starting automation.'))
    }
    return tabs
  }
  const run = async (definition: WorkflowDefinition): Promise<Record<string, unknown>> => {
    check()
    const runId = randomUUID()
    let data: Record<string, unknown> = {}
    // Capture the command's exact committed identities; never infer an output from the latest row.
    const workflow = { ...definition, runId, uiLocale: locale, onComplete: { mode: 'silent' as const },
      steps: definition.steps.map(step => ({ ...step, executor: async (...args: Parameters<typeof step.executor>) => {
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
      if (completed?.status !== 'completed') throw new Error(completed?.error || text('正文自动化步骤未完成，已停止。', 'The automation step did not complete. Automation stopped.'))
      return data
    } finally { activeRunId = undefined }
  }
  const readDraft = async (id: number): Promise<Draft> => {
    const draft = await invoke(session, 'db:draft-get-full', id, path)
    if (!draft || draft.status === 'finalized' || draft.status === 'archived' || draft.status === 'superseded' || !draft.content.trim()) {
      throw new Error(text('找不到可继续处理的正文草稿，自动化已停止。', 'No editable manuscript draft was found. Automation stopped.'))
    }
    assertEditorUnchanged(draft)
    return draft
  }
  const reviewDefinition = (draft: Draft, title: string) => createReviewOnlyWorkflow({
    openResult: false,
    projectPath: path, chapterNumber: draft.chapterNumber, chapterTitle: title,
    draftPath: `ai-novel://draft/${draft.id}`, draftContent: draft.content,
    sourceDraft: { id: draft.id, chapterNumber: draft.chapterNumber, version: draft.version,
      status: draft.status as 'draft' | 'revised' | 'reviewed', contentRevision: 0 },
  }, session)

  try {
    const llm = useLLMStore.getState()
    const modelId = preferredGenerationModelId(llm.models, routeStageModel('drafting', llm).modelId)
    if (!modelId) throw new Error(text('请先在设置中配置可用于文本生成的模型。', 'Configure a text generation model in Settings first.'))
    const revisionModelId = preferredGenerationModelId(llm.models, routeStageModel('refinement', llm).modelId) ?? modelId
    const wordsTarget = chapterDefaultWordsTarget(project.novelConfig.wordsPerChapter)
    const chapters = await readWritableChapters(session, locale)
    check()
    let chapter = chapters.writable[0]
    let processed = 0
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
      const drafts = await invoke(session, 'db:draft-list', chapter, path)
      // Archived and superseded versions are history; continue only the latest live draft.
      const latest = drafts.filter(item => ['draft', 'reviewed', 'revised'].includes(item.status))
        .sort((a, b) => b.version - a.version)[0]
      if (drafts.some(item => item.status === 'finalized')) throw new Error(text('本章已定稿，请刷新项目后重新开启自动化。', 'This chapter is already finalized. Refresh the book before restarting automation.'))
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
        phase('merging')
        const tabs = assertEditorUnchanged(draft)
        check()
        const merged = requireIpcSuccess(await ipc.invokeWithProjectSession(session, 'db:revision-merge', {
          revisionId: revision.id, targetDraftId: draft.id, expectedDraftContent: draft.content,
          mergedContent: revision.content, wordCount: countDraftUnits(revision.content),
        }, path), text('自动合并修稿', 'Automatically merge revision'))
        if (!isProjectSessionCurrent(session)) throw new AutomationStopped()
        for (const tab of tabs) useEditorStore.getState().settleMergedRevision(tab.id,
          { content: draft.content, contentRevision: tab.contentRevision ?? 0 }, revision.content)
        draft = await readDraft(draft.id)
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
      draft = await readDraft(draft.id)
      const tab = assertEditorUnchanged(draft)[0]
      const snapshotTab = tab ? { ...tab, draftId: draft.id, chapterNumber: chapter, projectSessionLease: session.leaseId } : undefined
      if (snapshotTab) useEditorStore.setState(state => ({ tabs: state.tabs.map(item => item.id === snapshotTab.id ? snapshotTab : item) }))
      await run(createFinalizeWorkflow({ projectPath: path, chapterNumber: chapter, chapterTitle: title,
        draftPath: `ai-novel://draft/${draft.id}`, draftContent: draft.content,
        stopOnPostProcessFailure: true, eventSource: 'batch',
        ...(snapshotTab ? { snapshot: captureFinalizationSnapshot({ tab: snapshotTab, projectSession: session, chapterTitle: title }) } : {}),
      }, session))
      await useDraftStore.getState().loadChapterDrafts(chapter, path, session)
      check()
      const authority = await readWritableChapters(session, locale)
      check()
      if (!authority.writable.includes(chapter + 1)) throw new Error(text('下一章暂不可写，正文自动化已停止。', 'The next chapter is not writable yet. Automation stopped.'))
      processed++
      chapter++
    }
  } catch (error) {
    useManuscriptAutomation.setState({ error: !(error instanceof AutomationStopped), message: error instanceof AutomationStopped
      ? text('正文自动化已停止，已生成的内容已保留。', 'Automation stopped. Generated content was preserved.')
      : displayedErrorMessage(locale, error) })
  } finally {
    activeRunId = undefined
    // Never allow an old lease's completion to change a newer mode.
    if (sameProjectSessionContext(useManuscriptAutomation.getState().session, session)) {
      useManuscriptAutomation.setState({ active: false, stopping: false })
    }
  }
}
