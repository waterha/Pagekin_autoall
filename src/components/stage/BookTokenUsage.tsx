import { useEffect, useMemo, useState } from 'react'
import { getLLMStats, type LLMStats } from '../../services/stats-service'
import type { ProjectSessionContext } from '../../shared/ipc-channels'
import type { LLMUsagePeriod } from '../../shared/llm-usage'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../shared/project-session-context'
import { useProjectStore } from '../../stores/project-store'
import { useLocaleStore } from '../../stores/locale-store'
import { LLMDataRequestGate } from '../panels/llm-data-request-gate'

/** Book-local usage remains visible while automation runs or the author changes pages. */
export default function BookTokenUsage() {
  const project = useProjectStore(s => s.currentProject)
  const session = useMemo(() => projectSessionContextFromProject(project), [project])
  const text = useLocaleStore(s => s.text)
  const locale = useLocaleStore(s => s.locale)
  const [data, setData] = useState<{ session: ProjectSessionContext; stats: LLMStats } | null>(null)
  const [failedFor, setFailedFor] = useState<ProjectSessionContext | null>(null)

  useEffect(() => {
    if (!session) return
    const gate = new LLMDataRequestGate()
    let disposed = false
    const load = async () => {
      const ticket = gate.begin(session)
      const current = () => !disposed && gate.isCurrent(ticket, projectSessionContextFromProject(useProjectStore.getState().currentProject))
      try {
        const stats = await getLLMStats(session)
        if (!current()) return
        setData({ session, stats }); setFailedFor(null)
      } catch {
        if (current()) { setData(null); setFailedFor(session) }
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 5000)
    return () => { disposed = true; gate.invalidate(); window.clearInterval(timer) }
  }, [session])

  if (!session) return null
  const stats = data && sameProjectSessionContext(data.session, session) ? data.stats : null
  const rows: Array<[string, string, LLMUsagePeriod | undefined]> = [
    ['total', text('累计', 'All time'), stats ?? undefined],
    ['today', text('今日', 'Today'), stats?.periods?.today],
    ['week', text('本周', 'This week'), stats?.periods?.week],
  ]
  const incomplete = rows.some(([, , usage]) => usage && usage.knownUsageCalls < usage.totalCalls)
  return <section className="book-token-usage" aria-label={text('本书 Token 用量', 'Book token usage')}>
    <h3>{text('本书 Token 用量', 'Book token usage')}</h3>
    <dl>{rows.map(([id, label, usage]) => <div key={id}>
      <dt>{label}</dt>
      <dd>{usage ? usage.totalCalls === 0 ? '0' : usage.totalTokens === null ? text('未知', 'Unknown')
        : `${usage.knownUsageCalls < usage.totalCalls ? '≥ ' : ''}${usage.totalTokens.toLocaleString(locale)}` : '—'}</dd>
    </div>)}</dl>
    <p>{sameProjectSessionContext(failedFor, session) ? text('用量读取失败，稍后自动重试', 'Could not load usage; retrying shortly')
      : incomplete ? text('部分调用未返回用量，仅统计已知 Token', 'Some calls did not report usage; only known tokens are counted')
        : text('输入 + 输出 · 本地时间，周一开始', 'Input + output · local time, week starts Monday')}</p>
  </section>
}
