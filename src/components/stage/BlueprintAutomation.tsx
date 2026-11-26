import { Play, Square } from 'lucide-react'
import { useLocaleStore } from '../../stores/locale-store'
import { useProjectStore } from '../../stores/project-store'
import { sameProjectSessionContext, projectSessionContextFromProject } from '../../shared/project-session-context'
import { startBlueprintAutomation, stopBlueprintAutomation, useBlueprintAutomation } from '../../services/blueprint-automation'

export default function BlueprintAutomation() {
  const text = useLocaleStore(s => s.text)
  const project = useProjectStore(s => s.currentProject)
  const state = useBlueprintAutomation()
  const matches = sameProjectSessionContext(state.session, projectSessionContextFromProject(project))
  const active = matches && state.active
  return <div className="manuscript-automation">
    <button type="button" className="manuscript-automation-button" aria-pressed={active}
      disabled={!project || state.stopping || (state.active && !matches)}
      title={text('每批规划 5 章，自动继续直到达到作品总章数；已有蓝图会保留，网络或模型服务临时故障每隔 30 秒自动重试。', 'Plan 5 chapters per batch and continue to the chapter total, preserving existing blueprints. Retry temporary network or model service failures every 30 seconds.')}
      onClick={() => { if (active) stopBlueprintAutomation(); else void startBlueprintAutomation() }}>
      {active ? <Square size={13} aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
      {state.stopping && matches ? text('正在停止…', 'Stopping…') : active ? text('停止蓝图自动化', 'Stop blueprint automation') : text('蓝图自动化', 'Automate blueprints')}
    </button>
    <span className="manuscript-automation-status" role="status" data-error={matches && state.error || undefined}>
      {active ? state.networkRetryWaiting ? state.message : state.startChapter === null ? text('正在准备蓝图规划…', 'Preparing blueprint planning…')
        : text(`正在规划第 ${state.startChapter}–${state.endChapter} 章 · 共 ${state.total} 章`, `Planning chapters ${state.startChapter}–${state.endChapter} · ${state.total} total`)
        : matches && state.message ? state.message : text('每批 5 章，自动规划至完成', 'Plan 5 chapters per batch until complete')}
    </span>
  </div>
}
