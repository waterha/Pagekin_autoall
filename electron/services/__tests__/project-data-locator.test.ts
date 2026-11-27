import { CURRENT_DESKTOP_SCHEMA_VERSION } from '../../migrations/desktop-registry'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeProjectDatabase, createProjectDatabase, getProjectDb, initProjectDatabase, initProjectDatabaseAsync } from '../../database'
import { createCanonicalProjectManifest } from '../../../src/shared/project-format'
import { getProjectDataRoot } from '../project-data-locator'
import { probeProjectSqlite, openProjectSqlite, readSqliteContentIdentity } from '../sqlite-project-migration'
import { runProjectOpenWorker } from '../project-open-worker-client'

vi.mock('../project-open-worker-client', () => ({ runProjectOpenWorker: vi.fn() }))

const Database = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
const roots: string[] = []
function fixture() {
  const base = path.resolve('.runtime/.cache/novel-quality-modernization/s04-locator')
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(path.join(base, 'project-')); roots.push(root)
  const data = path.join(root, '.ai-novel'); fs.mkdirSync(data)
  const manifest = createCanonicalProjectManifest({ projectId: randomUUID(), createdAt: new Date().toISOString() })
  fs.writeFileSync(path.join(data, 'project.json'), JSON.stringify(manifest))
  return { root, data, file: path.join(data, 'project.db'), manifest }
}
afterEach(() => { closeProjectDatabase(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
describe('canonical project activation', () => {
  it('publishes async admission only after the verified bytes match, retaining the previous book while waiting', async () => {
    const old = fixture(), next = fixture()
    createProjectDatabase(old.root); initProjectDatabase(old.root); createProjectDatabase(next.root)
    const previous = getProjectDb()!
    let complete!: () => void
    vi.mocked(runProjectOpenWorker).mockImplementation(async (operation, databasePath) => {
      if (operation === 'open') return openProjectSqlite({ databasePath })
      await new Promise<void>(resolve => { complete = resolve })
      return readSqliteContentIdentity(databasePath)
    })
    const opening = initProjectDatabaseAsync(next.root)
    await vi.waitFor(() => expect(complete).toBeDefined())
    expect(getProjectDb()).toBe(previous)
    expect(previous.open).toBe(true)
    complete(); await opening
    expect(previous.open).toBe(false)
    expect(getProjectDataRoot(next.root)).toBe(next.data)
    vi.mocked(runProjectOpenWorker).mockImplementation(async (operation, databasePath) => operation === 'open'
      ? openProjectSqlite({ databasePath }) : readSqliteContentIdentity(databasePath))
    await initProjectDatabaseAsync(next.root)
    expect(getProjectDataRoot(next.root)).toBe(next.data)
    expect(getProjectDb()!.open).toBe(true)
  })
  it('rejects changed bytes during async admission without closing the previously opened book', async () => {
    const old = fixture(), next = fixture()
    createProjectDatabase(old.root); initProjectDatabase(old.root); createProjectDatabase(next.root)
    const previous = getProjectDb()!
    vi.mocked(runProjectOpenWorker).mockImplementation(async (operation, databasePath) => operation === 'open'
      ? openProjectSqlite({ databasePath }) : { database: '0'.repeat(64), wal: '0'.repeat(64) })
    await expect(initProjectDatabaseAsync(next.root)).rejects.toThrow('SOURCE_CHANGED_SINCE_PROBE')
    expect(getProjectDb()).toBe(previous)
    expect(previous.open).toBe(true)
    expect(() => getProjectDataRoot(next.root)).toThrow('PROJECT_DATA_NOT_READY')
  })
  it('requires explicit new-project creation and revokes the locator on close', () => {
    const f = fixture()
    expect(() => initProjectDatabase(f.root)).toThrow()
    expect(fs.existsSync(f.file)).toBe(false)
    expect(() => getProjectDataRoot(f.root)).toThrow('PROJECT_DATA_NOT_READY')
    createProjectDatabase(f.root); initProjectDatabase(f.root)
    expect(getProjectDataRoot(f.root)).toBe(f.data)
    closeProjectDatabase()
    expect(() => getProjectDataRoot(f.root)).toThrow('PROJECT_DATA_NOT_READY')
    expect(fs.existsSync(path.join(f.root, '.vela'))).toBe(false)
  })
  it('does not rerun data backfill on same-schema reopen and fences only after verification', () => {
    const f = fixture(); createProjectDatabase(f.root); initProjectDatabase(f.root)
    const db = getProjectDb()!
    db.prepare('INSERT INTO contents(body) VALUES (?)').run('合成正文')
    db.exec(`INSERT INTO drafts_all(chapter_number,version,content_id,word_count) VALUES(1,1,1,777);
      INSERT INTO import_runs(id,root_run_id,effect_namespace,source_fingerprint,manifest_fingerprint,locale,total_chapters,manifest_chapter_count,status,execution_owner,execution_epoch,lease_expires_at)
      VALUES('fixture','fixture','fixture','source','manifest','zh-CN',1,1,'running','old-owner',5,12345)`)
    closeProjectDatabase()
    const before = probeProjectSqlite({ databasePath: f.file })
    expect(before.schemaVersion).toBe(CURRENT_DESKTOP_SCHEMA_VERSION)
    initProjectDatabase(f.root)
    expect(getProjectDb()!.prepare('SELECT word_count FROM drafts').pluck().get()).toBe(777)
    expect(getProjectDb()!.prepare('SELECT execution_owner,execution_epoch,lease_expires_at FROM import_runs').get()).toEqual({ execution_owner: '', execution_epoch: 6, lease_expires_at: 0 })
    closeProjectDatabase(); initProjectDatabase(f.root)
    expect(getProjectDb()!.prepare('SELECT execution_epoch FROM import_runs').pluck().get()).toBe(6)
  })
  it('rejects an unknown schema before a writable connection can fence source sessions', () => {
    const f = fixture(); createProjectDatabase(f.root)
    const db = new Database(f.file); db.exec('ALTER TABLE contents ADD COLUMN unknown_fork TEXT'); db.close()
    const before = fs.readFileSync(f.file)
    expect(() => initProjectDatabase(f.root)).toThrow('UNRECOGNIZED_SCHEMA')
    expect(fs.readFileSync(f.file)).toEqual(before)
    expect(getProjectDb()).toBeNull()
  })
  it('rejects dual roots and revoked manifest identity without writing the legacy source', () => {
    const f = fixture(); createProjectDatabase(f.root); initProjectDatabase(f.root)
    fs.writeFileSync(path.join(f.data, 'project.json'), JSON.stringify({ ...f.manifest, projectId: randomUUID() }))
    expect(() => getProjectDataRoot(f.root)).toThrow('PROJECT_MANIFEST_CHANGED')
    fs.mkdirSync(path.join(f.root, '.vela'))
    expect(() => initProjectDatabase(f.root)).toThrow('PROJECT_MIGRATION_REQUIRED')
    expect(fs.readdirSync(path.join(f.root, '.vela'))).toEqual([])
  })
})
