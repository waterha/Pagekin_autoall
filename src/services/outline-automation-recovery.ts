import type { ProjectSessionContext } from '../shared/ipc-channels'
import type { GenerationRecoveryContext } from '../shared/generation-owner-contract'
import type { MainGenerationRunHandle } from './generation/generation-runtime'
import { sameProjectPathKey } from '../shared/project-session-context'
import { renderPlotOutlineRange, validPlotOutlineAuthorPrefix } from '../shared/plot-outline-contract'
import { globalEventBus } from '../shared/event-bus'
import { editorSaveHandler, useEditorStore, type EditorTab } from '../stores/editor-store'
import { useWorkflowStore, workflowResourceKey } from '../stores/workflow-store'
import { ipc } from './ipc-client'
import { requireIpcSuccess } from './ipc-result'
import { parseCoreField } from './resource-protocol'

type Text = (zh: string, en: string) => string
export class OutlineRecoveryBlocked extends Error {}
const dirty = (tab: EditorTab) => tab.dirty || tab.savedContent !== undefined && tab.content !== tab.savedContent

/** Save through the editor's own handler, including its durable recovery-save receipt. */
export async function saveOutlineAutomationEditors(session: ProjectSessionContext, check: () => void, text: Text): Promise<void> {
  const tabs = () => useEditorStore.getState().tabs.filter(tab => tab.type === 'arch-file'
    && sameProjectPathKey(tab.projectKey, session.projectPath))
  for (let attempt = 0; attempt < 3; attempt++) {
    check()
    const pending = tabs().filter(dirty)
    if (!pending.length) return
    if (useWorkflowStore.getState().getResourceConflict({ projectPath: session.projectPath,
      resourceKeys: [workflowResourceKey('architecture')] })) {
      throw new OutlineRecoveryBlocked(text('架构仍有任务正在运行，请等待它结束。未保存的修改已保留。', 'An architecture task is still active. Wait for it to finish. Unsaved edits were preserved.'))
    }
    for (const candidate of pending) {
      check()
      const tab = tabs().find(item => item.id === candidate.id)
      if (!tab || !dirty(tab)) continue
      const field = parseCoreField(tab.filePath ?? '')
      const peers = tabs().filter(item => !item.planningRecovery && field && parseCoreField(item.filePath ?? '') === field)
      if (peers.some(item => dirty(item) && item.content !== tab.content)) {
        throw new OutlineRecoveryBlocked(text('同一架构文档有不同的未保存版本，已保留全部修改，请先合并内容。', 'This architecture document has different unsaved versions. All edits were preserved; merge them first.'))
      }
      if (tab.projectSessionLease && tab.projectSessionLease !== session.leaseId) {
        throw new OutlineRecoveryBlocked(text('架构编辑属于旧会话，请重新打开文档。修改已保留。', 'This architecture edit belongs to an older session. Reopen the document. Edits were preserved.'))
      }
      const save = editorSaveHandler(tab)
      if (save) {
        await save()
        check()
      } else {
        if (!field || field === 'charactersArch' || tab.planningRecovery || tab.content === undefined) {
          throw new OutlineRecoveryBlocked(text('这份架构修改暂时无法自动保存，原内容已保留，请打开对应文档处理。', 'This architecture edit cannot be saved automatically. Its content was preserved; open the document to resolve it.'))
        }
        const snapshot = { content: tab.content, contentRevision: tab.contentRevision ?? 0 }
        requireIpcSuccess(await ipc.invokeWithProjectSession(session, 'db:project-core-update',
          { [field]: snapshot.content }, session.projectPath), text('自动保存架构', 'Automatically save architecture'))
        check()
        const saved = await ipc.invokeWithProjectSession(session, 'db:project-core-get', session.projectPath)
        check()
        if (saved?.[field as 'premise' | 'worldbuilding' | 'synopsis'] !== snapshot.content) {
          throw new Error(text('架构自动保存尚未确认，修改已保留。', 'The architecture save has not been confirmed. Edits were preserved.'))
        }
        useEditorStore.getState().settleTabSave(tab.id, snapshot)
      }
    }
  }
  if (tabs().some(dirty)) throw new OutlineRecoveryBlocked(text('架构在自动保存期间持续变化，请暂停编辑后重试。修改已保留。', 'Architecture kept changing while being saved. Pause editing and try again. Edits were preserved.'))
}

export type OutlineRecoveryAction =
  | { kind: 'saved' }
  | { kind: 'resume'; handle: MainGenerationRunHandle; range: { from: number; to: number } }
  | { kind: 'restart'; handle: MainGenerationRunHandle; range: { from: number; to: number }; targetUnits: number }

/** Only commit complete accepted chapters; incomplete model output is never promoted to saved text. */
export async function recoverOutlineAutomation(
  session: ProjectSessionContext, initial: GenerationRecoveryContext, check: () => void, text: Text,
): Promise<OutlineRecoveryAction> {
  let context = initial
  for (let hop = 0; hop < 8; hop++) {
    check()
    const { plotOutline: progress, plotOutlineRecovery: recovery, planningContinuation: continuation } = context
    if (!progress || !recovery || recovery.leaseEpoch !== session.leaseId) {
      throw new OutlineRecoveryBlocked(text('无法读取大纲恢复进度，已保留原稿。', 'Outline recovery progress is unavailable. The original was preserved.'))
    }
    if (recovery.inFormalOutline || continuation?.state === 'complete') return { kind: 'saved' }
    if (continuation?.state === 'continued' && continuation.nextHandle) {
      context = await ipc.invokeWithProjectSession(session, 'generation:read-context', { handle: continuation.nextHandle })
      check()
      continue
    }
    if (continuation?.state === 'source-changed' || continuation?.state === 'source-invalid'
      || recovery.writeState.kind === 'blocked' && recovery.writeState.reason !== 'author-saved') {
      throw new OutlineRecoveryBlocked(text('大纲来源已变化或生成尚未确认结束，无法自动覆盖。已保存内容和恢复稿均已保留。', 'Outline sources changed or generation has not confirmed completion. Saved text and recovery drafts were preserved.'))
    }
    if (!recovery.saved && progress.cursor.kind !== 'stopped') {
      return { kind: 'resume', handle: context.handle, range: progress.range }
    }
    if (!recovery.saved) {
      if (progress.cursor.kind !== 'stopped' || progress.cursor.reason !== 'attempts-exhausted') {
        throw new OutlineRecoveryBlocked(text('本次生成的完成状态不明确，已保留恢复稿，请检查后继续。', 'This generation has an uncertain completion state. Its recovery draft was preserved; check it before continuing.'))
      }
      const chapters = progress.composition?.chapters ?? []
      if (chapters.length) {
        const range = { from: progress.range.from, to: chapters.at(-1)!.chapterNumber }
        const synopsis = renderPlotOutlineRange(progress.composition!.text, range, progress.sourceExpected)
        if (!validPlotOutlineAuthorPrefix(synopsis, progress, range)) throw new OutlineRecoveryBlocked(text(
          '恢复稿中的已完成章节不连续，已保留原文，无法自动保存。', 'Completed recovery chapters are not consecutive. The original was preserved and cannot be saved automatically.'))
        // Stable across a lost save response: the main owner returns the same receipt on retry.
        requireIpcSuccess(await ipc.invokeWithProjectSession(session, 'db:project-core-synopsis-commit', {
          synopsis, expected: progress.sourceExpected,
          authorRecovery: { sourceHandle: recovery.sourceHandle, leaseEpoch: recovery.leaseEpoch,
            operationId: `outline-automation-prefix:${context.handle.runId}`, committedRange: range },
        }, session.projectPath), text('自动保存已完成的大纲', 'Automatically save completed outline chapters'))
        check()
        globalEventBus.emit('ARCH_FILE_UPDATED', { fileName: 'synopsis.md', projectPath: session.projectPath, projectSession: session, runId: context.handle.runId })
        context = await ipc.invokeWithProjectSession(session, 'generation:read-context', { handle: context.handle })
        check()
        continue
      }
    }
    if (continuation?.state === 'ready' && continuation.remainingRange) {
      return { kind: 'restart', handle: continuation.sourceHandle, range: continuation.remainingRange, targetUnits: continuation.targetUnits }
    }
    throw new OutlineRecoveryBlocked(text('大纲恢复稿还不能继续，已保留全部内容，请检查恢复提示。', 'The outline recovery draft cannot continue yet. All content was preserved; check its recovery notice.'))
  }
  throw new OutlineRecoveryBlocked(text('大纲恢复记录衔接异常，已停止并保留全部内容。', 'The outline recovery chain is inconsistent. Automation stopped and preserved all content.'))
}
