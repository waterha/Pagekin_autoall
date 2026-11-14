import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type BetterSqlite3 from 'better-sqlite3'

import { getProjectDb } from '../../database'
import { LLMHistoryRepository } from '../llm-repository'

vi.mock('../../database', () => ({ getProjectDb: vi.fn() }))

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as typeof import('better-sqlite3')
let db: BetterSqlite3.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE llm_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id TEXT NOT NULL,
      model_name TEXT DEFAULT '',
      purpose TEXT DEFAULT '',
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      duration_ms INTEGER DEFAULT 0,
      success INTEGER DEFAULT 1,
      error_message TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `)
  vi.mocked(getProjectDb).mockReturnValue(db)
})

afterEach(() => db.close())

function log(success: boolean, errorMessage?: string): void {
  LLMHistoryRepository.logCall({
    modelId: 'model-1',
    modelName: 'Grok 4',
    purpose: 'chapter-draft',
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    durationMs: 500,
    success,
    errorMessage,
  })
}

describe('LLMHistoryRepository safe finish reasons', () => {
  it('returns only structured finish reasons without exposing raw provider errors', () => {
    log(true)
    log(false, 'finish:content_filter')
    log(false, 'Authorization: Bearer private-provider-error')

    const history = LLMHistoryRepository.getHistory() as Array<Record<string, unknown>>

    expect(history.map(row => row.finishReason)).toEqual([null, 'content_filter', 'stop'])
    expect(JSON.stringify(history)).not.toMatch(/Authorization|Bearer|private-provider-error/u)
  })
})

describe('book token totals by local calendar', () => {
  function usage(at: Date | string, total: number | null, success = 1) {
    db.prepare(`INSERT INTO llm_calls (model_id, total_tokens, success, created_at) VALUES ('model', ?, ?, ?)`)
      .run(total, success, typeof at === 'string' ? at : at.toISOString())
  }

  it('counts all history, local midnight and Monday boundaries, including failed calls with usage', () => {
    const now = new Date(2026, 10, 14, 12)
    const monday = new Date(2026, 10, 9)
    const today = new Date(2026, 10, 14)
    usage(new Date(monday.getTime() - 1000), 100)
    usage(monday, 200)
    usage(new Date(today.getTime() - 1000), 300)
    // Older rows use UTC SQLite timestamps, without a timezone suffix.
    usage(today.toISOString().slice(0, 19).replace('T', ' '), 400)
    usage(now, 500, 0)
    usage(now, null, 0)
    const stats = LLMHistoryRepository.getStats(now)
    expect(stats).toMatchObject({ totalCalls: 6, totalTokens: 1500, failedCalls: 2, knownUsageCalls: 5,
      periods: {
        today: { totalCalls: 3, knownUsageCalls: 2, totalTokens: 900 },
        week: { totalCalls: 5, knownUsageCalls: 4, totalTokens: 1400 },
      } })
    // On Sunday the week still starts on the previous Monday.
    expect(LLMHistoryRepository.getStats(new Date(2026, 10, 15, 12)).periods.week.totalTokens).toBe(1400)
    expect(LLMHistoryRepository.getStats(new Date(2026, 10, 16, 12)).periods.week.totalCalls).toBe(0)
  })

  it('does not truncate to the recent-call list or mix data between books', () => {
    for (let index = 0; index < 80; index++) usage(new Date(2026, 10, 14, 10), 10)
    expect(LLMHistoryRepository.getHistory(30)).toHaveLength(30)
    expect(LLMHistoryRepository.getStats(new Date(2026, 10, 14, 12))).toMatchObject({ totalTokens: 800,
      periods: { today: { totalTokens: 800 }, week: { totalTokens: 800 } } })
    vi.mocked(getProjectDb).mockReturnValue(null)
    expect(LLMHistoryRepository.getStats()).toMatchObject({ totalCalls: 0, totalTokens: null,
      periods: { today: { totalCalls: 0 }, week: { totalCalls: 0 } } })
  })

  it('distinguishes unknown usage from a book without calls', () => {
    const now = new Date(2026, 10, 14, 12)
    expect(LLMHistoryRepository.getStats(now).periods.today).toEqual({ totalCalls: 0, knownUsageCalls: 0, totalTokens: null })
    usage(now, null)
    expect(LLMHistoryRepository.getStats(now).periods.today).toEqual({ totalCalls: 1, knownUsageCalls: 0, totalTokens: null })
  })

  it('normalizes offset-aware timestamps and excludes the next day/week', () => {
    const now = new Date(2026, 10, 15, 12)
    const start = new Date(2026, 10, 15)
    // Same instant written with an explicit offset rather than Z.
    const shifted = new Date(start.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19) + '+08:00'
    usage(shifted, 25)
    usage(new Date(2026, 10, 16), 100)
    expect(LLMHistoryRepository.getStats(now).periods).toEqual({
      today: { totalCalls: 1, knownUsageCalls: 1, totalTokens: 25 },
      week: { totalCalls: 1, knownUsageCalls: 1, totalTokens: 25 },
    })
  })
})
