import type Database from 'better-sqlite3'
import { getProjectDb } from '../database'
import type { LLMUsagePeriods, LLMUsagePeriod } from '../../src/shared/llm-usage'

export class LLMHistoryRepository {
  /** 记录一次 LLM 调用 */
  static logCall(call: {
    modelId: string
    modelName: string
    purpose: string
    promptTokens: number | null
    completionTokens: number | null
    totalTokens: number | null
    durationMs: number
    success: boolean
    errorMessage?: string
  }, db: Database.Database | null = getProjectDb()): void {
    if (!db) return

    db.prepare(`
      INSERT INTO llm_calls (model_id, model_name, purpose, prompt_tokens, completion_tokens, total_tokens, duration_ms, success, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      call.modelId, call.modelName, call.purpose,
      call.promptTokens, call.completionTokens, call.totalTokens,
      call.durationMs, call.success ? 1 : 0, call.errorMessage ?? ''
    )
  }

  /** 获取调用统计 */
  static getStats(now = new Date()): {
    totalCalls: number
    successfulCalls: number
    failedCalls: number
    knownUsageCalls: number
    totalTokens: number | null
    totalPromptTokens: number | null
    totalCompletionTokens: number | null
    periods: LLMUsagePeriods
  } {
    const db = getProjectDb()
    const empty: LLMUsagePeriod = { totalCalls: 0, knownUsageCalls: 0, totalTokens: null }
    if (!db) return {
      totalCalls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      knownUsageCalls: 0,
      totalTokens: null,
      totalPromptTokens: null,
      totalCompletionTokens: null,
      periods: { today: { ...empty }, week: { ...empty } },
    }

    const row = db.prepare(`
      SELECT
        COUNT(*) as totalCalls,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successfulCalls,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failedCalls,
        SUM(CASE WHEN total_tokens IS NOT NULL THEN 1 ELSE 0 END) as knownUsageCalls,
        SUM(total_tokens) as totalTokens,
        SUM(prompt_tokens) as totalPromptTokens,
        SUM(completion_tokens) as totalCompletionTokens
      FROM llm_calls
    `).get() as {
      totalCalls: number
      successfulCalls: number | null
      failedCalls: number | null
      knownUsageCalls: number | null
      totalTokens: number | null
      totalPromptTokens: number | null
      totalCompletionTokens: number | null
    }

    // Boundaries use the desktop's local calendar (Monday starts the week).
    // Convert them to UTC before comparing SQLite UTC and offset-aware ISO timestamps.
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (now.getDay() + 6) % 7)
    const nextMonday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7)
    const period = (start: Date, end: Date): LLMUsagePeriod => {
      const usage = db.prepare(`SELECT COUNT(*) AS totalCalls,
        COUNT(total_tokens) AS knownUsageCalls, SUM(total_tokens) AS totalTokens
        FROM llm_calls WHERE julianday(created_at) >= julianday(?) AND julianday(created_at) < julianday(?)
      `).get(start.toISOString(), end.toISOString()) as LLMUsagePeriod
      return usage
    }
    return {
      ...row,
      successfulCalls: row.successfulCalls ?? 0,
      failedCalls: row.failedCalls ?? 0,
      knownUsageCalls: row.knownUsageCalls ?? 0,
      periods: { today: period(today, tomorrow), week: period(monday, nextMonday) },
    }
  }

  /** 获取最近 LLM 调用记录 */
  static getHistory(limit: number = 50): unknown[] {
    const db = getProjectDb()
    if (!db) return []
    return db.prepare(`
      SELECT id, model_id as modelId, model_name as modelName, purpose,
        prompt_tokens as promptTokens, completion_tokens as completionTokens,
        total_tokens as totalTokens, duration_ms as durationMs,
        success,
        CASE
          WHEN success = 1 THEN 'stop'
          WHEN error_message = 'finish:length' THEN 'length'
          WHEN error_message = 'finish:content_filter' THEN 'content_filter'
          WHEN error_message IN ('finish:cancelled', 'cancelled') THEN 'cancelled'
          WHEN error_message = 'finish:error' THEN 'error'
          WHEN error_message = 'finish:unknown' THEN 'unknown'
          ELSE NULL
        END as finishReason,
        created_at as createdAt
      FROM llm_calls ORDER BY id DESC LIMIT ?
    `).all(limit)
  }
}
