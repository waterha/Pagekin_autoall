import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { M01_GENERATION_SQL } from '../../migrations/m01-generation-runs'
import { GenerationRunRepository, textHash } from '../../repositories/generation-run-repository'
import { getGenerationLedgerIndex } from '../generation-ledger-index'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const databases: import('better-sqlite3').Database[] = []
const roots: string[] = []

function openGenerationDb(file = ':memory:'): import('better-sqlite3').Database {
  const db = new Database(file)
  databases.push(db)
  db.exec(M01_GENERATION_SQL)
  return db
}

function makeBinding(overrides: Record<string, unknown> = {}, manifestOverrides: Record<string, unknown> = {}) {
  const hash = textHash('seed')
  return {
    projectId: 'project-1',
    epoch: 'epoch-1',
    contextSnapshotId: 'ctx-1',
    fingerprint: {
      chapterBriefHash: hash,
      authorGuidanceHash: hash,
      dependencyHash: hash,
      contextSnapshotHash: hash,
      templateHash: hash,
      skillSnapshotHash: hash,
      modelLeaseRevision: hash,
      policyHash: hash,
      outputContractHash: hash,
    },
    sourceManifest: {
      operation: 'chapter-draft',
      ...manifestOverrides,
    },
    sourceRefs: [],
    ...overrides,
  }
}

afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('连接级 TEMP 账本索引 (GenerationLedgerIndex)', () => {
  it('只创建连接本地 TEMP 表与触发器，绝不修改 main schema', () => {
    const db = openGenerationDb()
    const before = db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()
    const index = getGenerationLedgerIndex(db)
    index.sync()
    const after = db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()
    expect(after).toEqual(before)

    const tempObjects = db.prepare("SELECT type,name FROM sqlite_temp_master ORDER BY type,name").all() as { type: string; name: string }[]
    expect(tempObjects.some(obj => obj.type === 'table' && obj.name === 'pagekin_run_index')).toBe(true)
    expect(tempObjects.some(obj => obj.type === 'table' && obj.name === 'pagekin_attempt_index')).toBe(true)
    expect(tempObjects.some(obj => obj.type === 'index' && obj.name === 'idx_pagekin_run_fin_slot')).toBe(true)
    expect(tempObjects.some(obj => obj.type === 'index' && obj.name === 'idx_pagekin_att_review')).toBe(true)
  })

  it('响应同连接写入、更新、删除、回滚及跨连接外部写入，并容忍坏 JSON', () => {
    const cache = path.resolve('.runtime/.cache/ledger-index-tests')
    fs.mkdirSync(cache, { recursive: true })
    const root = fs.mkdtempSync(path.join(cache, 'sync-'))
    roots.push(root)
    const file = path.join(root, 'book.db')

    const db = openGenerationDb(file)
    const index = getGenerationLedgerIndex(db)
    const readerDb = new Database(file, { readonly: true })
    databases.push(readerDb)
    const readerIndex = getGenerationLedgerIndex(readerDb)

    const repo = new GenerationRunRepository(() => db, () => 1000)
    const run = repo.open({
      ...makeBinding({}, { finalizationGenerationSlotKey: 'slot-1', batchIntent: { mode: 'draft_review' } }),
      operation: 'chapter-draft',
      uiActionNonce: 'nonce-1',
      frozenInputHash: textHash('input-1'),
      budget: { maxPhysicalRequests: 5, maxTokenLiability: 10000, maxOutputPerRequest: 2000, maxActiveElapsedMs: 60000 },
    })
    const reserved = repo.reserve(run.runId, 'att-1', textHash('req-1'), 1000, 500, undefined, 'chapter-draft')

    expect(index.runRootActionId(run.runId)).toBe(run.rootActionId)
    expect(index.finalizationSlotRunIds('slot-1')).toEqual([run.runId])
    expect(index.activeBatchIntentRunIds()).toEqual([run.runId])
    expect(index.attemptCountForRun(run.runId)).toBe(1)
    expect(index.hasInFlightAttemptForRun(run.runId)).toBe(true)
    expect(readerIndex.finalizationSlotRunIds('slot-1')).toEqual([run.runId])

    // 事务回滚不会保留脏索引行
    expect(() => db.transaction(() => {
      db.prepare(`UPDATE generation_runs SET binding_json=json_set(binding_json,'$."$runEffects"','x') WHERE run_id=?`).run(run.runId)
      expect(index.hasAuthorEffectForRoot(run.rootActionId)).toBe(true)
      throw new Error('abort-tx')
    })()).toThrow('abort-tx')
    expect(index.hasAuthorEffectForRoot(run.rootActionId)).toBe(false)

    // 写入 reviewRevisionEffect 与 draftCommit，验证关联索引和外部只读连接刷新
    db.prepare(`UPDATE generation_attempts SET usage_receipt_json=json_set(usage_receipt_json,'$.reviewRevisionEffect',json('{"kind":"review","id":42}'),'$.draftCommit',json('{"id":7,"chapterNumber":3,"batchId":"batch-9"}')) WHERE attempt_id=?`)
      .run(reserved.attempt.attemptId)
    expect(readerIndex.reviewEffectAttempts('review', 42)).toHaveLength(1)
    expect(readerIndex.draftCommitBindings(7, 3)).toHaveLength(1)
    expect(readerIndex.batchCommitRows('batch-9')).toHaveLength(1)

    // 损坏一条 usage_receipt_json 不会让触发器或索引崩溃
    db.prepare('INSERT INTO generation_attempts VALUES(?,?,?,?,?,?,?)').run(
      'att-corrupt', 'res-corrupt', run.runId, run.rootActionId, '{bad', '{not-json', 'nonce-corrupt',
    )
    expect(index.invalidUsageReceiptCount()).toBe(1)
    db.prepare("DELETE FROM generation_attempts WHERE attempt_id='att-corrupt'").run()
    expect(index.invalidUsageReceiptCount()).toBe(0)
  })

  it('在大量长书历史下通过 TEMP 索引定位且 snapshot 与查询保持常数级耗时', () => {
    const db = openGenerationDb()
    const index = getGenerationLedgerIndex(db)
    const repo = new GenerationRunRepository(() => db, () => 1000)
    const padding = '长篇冻结正文'.repeat(1500)
    const hash = textHash('seed')

    db.transaction(() => {
      for (let i = 0; i < 400; i++) {
        const rootId = `root-${i}`
        const runId = `run-${i}`
        const attemptId = `att-${i}`
        db.prepare('INSERT INTO generation_roots(root_action_id,idempotency_key,action_json,budget_json) VALUES(?,?,?,?)').run(
          rootId,
          `key-${i}`,
          JSON.stringify({ projectId: 'project-1', epoch: 'epoch-1', operation: 'chapter-draft', uiActionNonce: `n-${i}`, frozenInputHash: hash, rootActionId: rootId, status: 'sealed' }),
          JSON.stringify({ maxPhysicalRequests: 5, maxTokenLiability: 10000, maxOutputPerRequest: 2000, maxActiveElapsedMs: 60000 }),
        )
        db.prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?,?)').run(
          runId, rootId, JSON.stringify(makeBinding({ padding }, { finalizationGenerationSlotKey: `slot-${i}` })), 'completed', i, `open-${i}`,
        )
        db.prepare('INSERT INTO generation_attempts VALUES(?,?,?,?,?,?,?)').run(
          attemptId, `res-${i}`, runId, rootId,
          JSON.stringify({ attemptId, reservationId: `res-${i}`, rootActionId: rootId, status: 'settled', reservedTokens: 100, requestedOutputTokens: 50 }),
          JSON.stringify({ requestHash: hash, purpose: 'chapter-draft', replayTask: { padding } }),
          `nonce-${i}`,
        )
      }
    })()

    index.sync()

    const activeRun = repo.open({
      ...makeBinding(),
      operation: 'chapter-draft',
      uiActionNonce: 'live-run',
      frozenInputHash: hash,
      budget: { maxPhysicalRequests: 5, maxTokenLiability: 10000, maxOutputPerRequest: 2000, maxActiveElapsedMs: 60000 },
    })
    const activeAttempt = repo.reserve(activeRun.runId, 'live-att', hash, 1000, 500, undefined, 'chapter-draft')

    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT run_id FROM temp.pagekin_run_index WHERE finalization_slot_key=? ORDER BY ordinal`).all('slot-250') as { detail: string }[]
    expect(plan.some(row => row.detail.includes('USING INDEX idx_pagekin_run_fin_slot'))).toBe(true)

    const attPlan = db.prepare(`EXPLAIN QUERY PLAN SELECT attempt_id FROM temp.pagekin_attempt_index WHERE root_action_id=? ORDER BY ordinal`).all(activeRun.rootActionId) as { detail: string }[]
    expect(attPlan.some(row => row.detail.includes('USING INDEX idx_pagekin_att_root'))).toBe(true)

    expect(index.finalizationSlotRunIds('slot-250')).toEqual(['run-250'])
    const saved = repo.snapshot(activeAttempt.attempt.attemptId, 0, '流式增量文本')
    expect(saved.revision).toBe(1)
    expect(saved.text).toBe('流式增量文本')
    expect(index.activeAttempts().map(a => a.attempt_id)).toEqual([activeAttempt.attempt.attemptId])
  })
})
