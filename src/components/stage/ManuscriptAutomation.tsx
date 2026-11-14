import { Play, Square } from 'lucide-react'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { sameProjectSessionContext, projectSessionContextFromProject } from '../../shared/project-session-context'
import { startManuscriptAutomation, stopManuscriptAutomation, useManuscriptAutomation } from '../../services/manuscript-automation'

/** Kept beside Manuscript in the flow spine, available from every chapter. */
export default function ManuscriptAutomation() {
  const text = useLocaleStore(s => s.text)
  const project = useProjectStore(s => s.currentProject)
  const state = useManuscriptAutomation()
  const matches = sameProjectSessionContext(state.session, projectSessionContextFromProject(project))
  const active = matches && state.active
  const labels = {
    preparing: text('准备', 'Preparing'), writing: text('写作', 'Writing'),
    reviewing: text('审稿', 'Reviewing'), revising: text('修稿', 'Revising'),
    merging: text('合并修稿', 'Merging'), rechecking: text('复验', 'Rechecking'),
    finalizing: text('定稿及后处理', 'Finalizing and post-processing'),
    retrying: text('重试定稿后处理', 'Retrying post-processing'),
  }
  return <div className="manuscript-automation">
    <button type="button" className="manuscript-automation-button" aria-pressed={active}
      disabled={!project || state.stopping || (state.active && !matches)}
      title={text('自动保存正文修改并处理定稿冲突，依次写作、审稿、采纳全部修改、定稿，后处理失败时自动重试最多 3 轮，完成后继续下一章，直到已有蓝图结束。', 'Save manuscript edits and resolve finalization conflicts automatically, then write, review, accept all revisions, finalize, retry failed post-processing up to 3 times, and continue through the available blueprints.')}
      onClick={() => { if (active) stopManuscriptAutomation(); else void startManuscriptAutomation() }}>
      {active ? <Square size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
      {state.stopping && matches ? text('正在停止…', 'Stopping…') : active ? text('停止正文自动化', 'Stop automation') : text('正文自动化', 'Automate manuscript')}
    </button>
    <span className="manuscript-automation-status" role="status" data-error={matches && state.error || undefined}>
      {active ? state.phase === 'retrying' ? text(`第 ${state.chapter ?? '—'} 章 · 自动重试失败步骤（${state.retryAttempt}/3）`, `Chapter ${state.chapter ?? '—'} · Retrying failed steps (${state.retryAttempt}/3)`)
        : text(`第 ${state.chapter ?? '—'} 章 · ${labels[state.phase]}`, `Chapter ${state.chapter ?? '—'} · ${labels[state.phase]}`)
        : matches && state.message ? state.message : text('自动采纳全部审稿意见，逐章定稿', 'Accept all review issues and finalize each chapter')}
    </span>
  </div>
}
