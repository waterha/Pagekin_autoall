import { Play, Square } from 'lucide-react'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { sameProjectSessionContext, projectSessionContextFromProject } from '../../shared/project-session-context'
import { startOutlineAutomation, stopOutlineAutomation, useOutlineAutomation } from '../../services/outline-automation'

export default function OutlineAutomation() {
  const text = useLocaleStore(s => s.text)
  const project = useProjectStore(s => s.currentProject)
  const state = useOutlineAutomation()
  const matches = sameProjectSessionContext(state.session, projectSessionContextFromProject(project))
  const active = matches && state.active
  return <div className="manuscript-automation">
    <button type="button" className="manuscript-automation-button" aria-pressed={active}
      disabled={!project || state.stopping || (state.active && !matches)}
      title={text('每批生成 5 章大纲；自动保存、恢复中断并继续，网络或模型服务临时故障每隔 30 秒自动重试。', 'Generate 5 outline chapters per batch; automatically save, recover interruptions and continue. Retry temporary network or model service failures every 30 seconds.')}
      onClick={() => { if (active) stopOutlineAutomation(); else void startOutlineAutomation() }}>
      {active ? <Square size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
      {state.stopping && matches ? text('正在停止…', 'Stopping…') : active ? text('停止大纲自动化', 'Stop outline automation') : text('大纲自动化', 'Automate outline')}
    </button>
    <span className="manuscript-automation-status" role="status" data-error={matches && state.error || undefined}>
      {active ? state.phase !== 'generating' && state.message ? state.message : state.startChapter === null ? text('正在准备情节大纲…', 'Preparing plot outline…')
        : text(`正在生成第 ${state.startChapter}–${state.endChapter} 章大纲 · 共 ${state.total} 章`, `Generating outline chapters ${state.startChapter}–${state.endChapter} · ${state.total} total`)
        : matches && state.message ? state.message : text('每批 5 章，自动续写至全书大纲完成', 'Generate 5 chapters per batch until the full outline is complete')}
    </span>
  </div>
}
