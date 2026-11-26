import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GenerationRunSummaries } from '../generation-run-summaries'

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const databases: import('better-sqlite3').Database[] = []
const roots: string[] = []
function fixture() {
  const db = new Database(':memory:')
  databases.push(db)
  db.exec(`CREATE TABLE generation_runs(run_id TEXT PRIMARY KEY, root_action_id TEXT, status TEXT, created_at_ms INTEGER, binding_json TEXT)`)
  const insert = db.prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?)')
  db.transaction(() => {
    for (let i = 0; i < 100; i++) insert.run(`run-${i}`, `root-${i}`, 'completed', i,
      JSON.stringify({ projectId: 'book', epoch: 'lease', sourceManifest: { operation: 'chapter-draft', batchId: null }, history: '正文'.repeat(2000) }))
  })()
  return { db, reader: new GenerationRunSummaries(db) }
}
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) if (db.open) db.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('长篇作品运行摘要', () => {
  it('其他连接写入后会失效重读，并支持只读打开的项目', async () => {
    const cache = path.resolve('.runtime/.cache/run-summary-tests')
    fs.mkdirSync(cache, { recursive: true })
    const root = fs.mkdtempSync(path.join(cache, 'connection-'))
    roots.push(root)
    const file = path.join(root, 'book.db')
    const writer = new Database(file)
    databases.push(writer)
    writer.exec(`CREATE TABLE generation_runs(run_id TEXT PRIMARY KEY,root_action_id TEXT,status TEXT,created_at_ms INTEGER,binding_json TEXT)`)
    writer.prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?)').run('run', 'root', 'completed', 1,
      JSON.stringify({ projectId: 'book', epoch: 'first', sourceManifest: { operation: 'chapter-draft' } }))
    const readerDb = new Database(file, { readonly: true })
    databases.push(readerDb)
    const reader = new GenerationRunSummaries(readerDb)
    await reader.prepare(() => {})
    expect(reader.read()[0].identity).toContain('first')
    writer.prepare("UPDATE generation_runs SET binding_json=json_set(binding_json,'$.epoch','external'),status='paused'").run()
    expect(reader.read()[0]).toMatchObject({ status: 'paused', identity: expect.stringContaining('external') })
  })

  it('后续列表和状态变化不重新扫描历史正文，只读取发生变化的上下文', async () => {
    const { db, reader } = fixture()
    let ticks = 0
    await reader.prepare(() => { ticks++ })
    expect(ticks).toBeGreaterThan(1)
    expect(reader.read()).toHaveLength(100)
    const prepare = vi.spyOn(db, 'prepare')
    db.prepare("UPDATE generation_runs SET status='paused' WHERE run_id='run-99'").run()
    expect(reader.read()[0]).toMatchObject({ run_id: 'run-99', status: 'paused' })
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('json_extract(binding_json'))).toHaveLength(0)
    db.prepare("UPDATE generation_runs SET binding_json=json_set(binding_json,'$.epoch','new') WHERE run_id='run-0'").run()
    expect(reader.read().find(run => run.run_id === 'run-0')?.identity).toContain('new')
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('json_extract(binding_json'))).toHaveLength(1)
  })

  it('事务回滚不会把未提交身份留在缓存，也能检测删除后重新插入', async () => {
    const { db, reader } = fixture()
    await reader.prepare(() => {})
    const original = reader.read().find(run => run.run_id === 'run-0')!.identity
    expect(() => db.transaction(() => {
      db.prepare("UPDATE generation_runs SET binding_json=json_set(binding_json,'$.epoch','rollback') WHERE run_id='run-0'").run()
      expect(reader.read().find(run => run.run_id === 'run-0')!.identity).toContain('rollback')
      throw new Error('rollback')
    })()).toThrow('rollback')
    expect(reader.read().find(run => run.run_id === 'run-0')!.identity).toBe(original)
    db.prepare("DELETE FROM generation_runs WHERE run_id='run-0'").run()
    expect(reader.read()).toHaveLength(99)
    db.prepare('INSERT INTO generation_runs VALUES(?,?,?,?,?)').run('run-0', 'root-new', 'paused', 200,
      JSON.stringify({ projectId: 'book', epoch: 'reinserted', sourceManifest: { operation: 'new-operation', batchIntent: { mode: 'draft_review' } } }))
    expect(reader.read()[0]).toMatchObject({ root_action_id: 'root-new', identity: expect.stringContaining('reinserted') })
  })

  it('预热期间可中止旧项目，临时索引不改变数据库正式结构', async () => {
    const { db, reader } = fixture()
    const schema = db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all()
    await expect(reader.prepare(() => { throw new Error('session closed') })).rejects.toThrow('session closed')
    expect(db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schema)
  })
})
