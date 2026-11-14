import { initializeLegacyBaselineSchema } from '../../migrations/baseline-schema'
const normalization = vi.hoisted(() => ({ db: null as import('better-sqlite3').Database | null, root: null as string | null }))
vi.mock('../../database', async importOriginal => {
  const actual = await importOriginal<typeof import('../../database')>()
  return { ...actual, getProjectDb: () => normalization.db ?? actual.getProjectDb(), getCurrentProjectPath: () => normalization.root ?? actual.getCurrentProjectPath() }
})
function normalizeHistoricalFixture(projectPath: string): void {
  closeProjectDatabase()
  const file = path.join(projectPath, '.ai-novel', 'project.db')
  const before = fs.readFileSync(file)
  expect(() => initProjectDatabase(projectPath)).toThrow()
  expect(fs.readFileSync(file)).toEqual(before)
  const FixtureDatabase = createRequire(import.meta.url)('better-sqlite3') as typeof import('better-sqlite3')
  normalization.db?.close()
  normalization.db = new FixtureDatabase(file)
  normalization.root = projectPath
  dropLiveRowViews(normalization.db)
  initializeLegacyBaselineSchema(normalization.db)
  createLiveRowViews(normalization.db)
}
import { createRequire } from 'node:module'
import { createLiveRowViews, dropLiveRowViews } from '../../../test/helpers/live-row-views'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeProjectDatabase, getProjectDb } from '../../database'
import { openCanonicalProjectFixture as initProjectDatabase } from '../../../test/helpers/canonical-project-fixture'
import { reopenWithContent } from '../../../test/helpers/reopened-draft'
import { DraftRepository } from '../draft-repository'
import { FinalizationRepository } from '../finalization-repository'

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function finalize(draftId: number, chapterNumber: number, content: string, finalizationId: string): void {
  FinalizationRepository.commit({
    finalizationId,
    draftId,
    chapterNumber,
    chapterTitle: `第${chapterNumber}章`,
    content,
    contentHash: sha256(content),
    contentRevision: 1,
    targetFileName: `chapter-${chapterNumber}.md`,
  })
}

function finalizedDependency(
  draftId: number,
  chapterNumber: number,
  content: string,
  finalizationId: string,
) {
  return {
    kind: 'finalized' as const,
    draftId,
    chapterNumber,
    finalizationId,
    contentHash: sha256(content),
  }
}

let projectRoot = ''

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-novel-draft-dependency-'))
  initProjectDatabase(projectRoot)
})

afterEach(() => {
  normalization.db?.close(); normalization.db = null; normalization.root = null
  closeProjectDatabase()
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

describe('draft source dependencies', () => {
  it('bounds current-chapter reads at confirmed history rather than loading the entire long book', () => {
    const db = getProjectDb()!
    const body = '长篇正文。'.repeat(2000)
    let previous = 0
    db.transaction(() => {
      for (let chapter = 1; chapter <= 120; chapter++) {
        const contentId = Number(db.prepare('INSERT INTO contents(body) VALUES (?)').run(body).lastInsertRowid)
        previous = Number(db.prepare(`INSERT INTO drafts_all
          (chapter_number, version, source, content_id, word_count, status, source_dependencies)
          VALUES (?, 1, 'write', ?, ?, 'finalized', ?)`).run(chapter, contentId, body.length,
            JSON.stringify(previous ? [{ kind: 'legacy-finalized', draftId: previous, chapterNumber: chapter - 1, contentHash: sha256(body) }] : [])).lastInsertRowid)
      }
    })()
    const id = DraftRepository.create({ chapterNumber: 121, source: 'write', content: '当前章。', wordCount: 4,
      sourceDependencies: [{ kind: 'legacy-finalized', draftId: previous, chapterNumber: 120, contentHash: sha256(body) }] })
    const prepare = vi.spyOn(db, 'prepare')
    try {
      expect(DraftRepository.getMeta(id)?.dependenciesStale).toBe(false)
      // Loading one current source must not issue one body query per historical chapter.
      expect(prepare.mock.calls.filter(([sql]) => sql.includes('contents.body'))).toHaveLength(1)
    } finally { prepare.mockRestore() }
  })

  it('still expands a source first reached as confirmed history when a later candidate requires its lineage', () => {
    const first = DraftRepository.create({ chapterNumber: 1, source: 'write', content: '前史。', wordCount: 3 })
    const confirmed = DraftRepository.create({ chapterNumber: 2, source: 'write', content: '定稿。', wordCount: 3,
      sourceDependencies: [{ draftId: first, contentHash: sha256('前史。') }] })
    finalize(confirmed, 2, '定稿。', 'mixed-confirmed')
    const candidate = DraftRepository.create({ chapterNumber: 3, source: 'write', content: '候选。', wordCount: 3,
      sourceDependencies: [{ kind: 'candidate', draftId: confirmed, contentHash: sha256('定稿。') }] })
    const downstream = DraftRepository.create({ chapterNumber: 4, source: 'write', content: '后续。', wordCount: 3,
      sourceDependencies: [finalizedDependency(confirmed, 2, '定稿。', 'mixed-confirmed'),
        { kind: 'candidate', draftId: candidate, contentHash: sha256('候选。') }] })
    expect(DraftRepository.getMeta(downstream)?.dependenciesStale).toBe(false)
    DraftRepository.updateContent(first, '变化的前史。', 6)
    expect(DraftRepository.getMeta(downstream)?.dependenciesStale).toBe(true)
    expect(() => DraftRepository.create({ chapterNumber: 5, source: 'write', content: '不能继承。', wordCount: 5,
      sourceDependencies: [{ draftId: downstream, contentHash: sha256('后续。') }] })).toThrow('GENERATION_DRAFT_DEPENDENCY_STALE')
  })

  it('persists ordered source identities and keeps the downstream draft while marking changed prose stale', () => {
    const firstContent = '第一章候选原文。'
    const secondContent = '第二章候选原文。'
    const firstId = DraftRepository.create({
      chapterNumber: 1, source: 'write', content: firstContent, wordCount: 8,
    })
    const secondId = DraftRepository.create({
      chapterNumber: 2, source: 'write', content: secondContent, wordCount: 8,
    })
    const dependencies = [
      { draftId: secondId, contentHash: sha256(secondContent) },
      { draftId: firstId, contentHash: sha256(firstContent) },
    ]
    const downstreamId = DraftRepository.create({
      chapterNumber: 3,
      source: 'write',
      content: '第三章基于前两章候选。',
      wordCount: 11,
      sourceDependencies: dependencies,
    })

    expect(DraftRepository.getMeta(downstreamId)).toMatchObject({
      sourceDependencies: dependencies,
      dependenciesStale: false,
    })

    DraftRepository.updateContent(firstId, '第一章候选正文已由作者修改。', 14)
    expect(DraftRepository.getMeta(downstreamId)).toMatchObject({
      id: downstreamId,
      sourceDependencies: dependencies,
      dependenciesStale: true,
    })

    closeProjectDatabase()
    initProjectDatabase(projectRoot)
    expect(DraftRepository.getFull(downstreamId)).toMatchObject({
      content: '第三章基于前两章候选。',
      dependenciesStale: true,
    })
  })

  it('revalidates claimed dependencies at the main-process repository boundary', () => {
    const sourceContent = '被冻结的候选正文。'
    const sourceId = DraftRepository.create({
      chapterNumber: 1, source: 'write', content: sourceContent, wordCount: 9,
    })
    DraftRepository.updateContent(sourceId, '候选正文已变化。', 8)

    expect(() => DraftRepository.create({
      chapterNumber: 2,
      source: 'write',
      content: '不应保存的下游草稿。',
      wordCount: 10,
      sourceDependencies: [{ draftId: sourceId, contentHash: sha256(sourceContent) }],
    })).toThrow('GENERATION_DRAFT_DEPENDENCY_STALE')
    expect(DraftRepository.listByChapter(2)).toEqual([])
  })

  it('marks transitive dependents stale and rejects extending a stale lineage', () => {
    const firstContent = '第一章候选原文。'
    const secondContent = '第二章候选原文。'
    const thirdContent = '第三章候选原文。'
    const firstId = DraftRepository.create({
      chapterNumber: 1, source: 'write', content: firstContent, wordCount: 8,
    })
    const secondId = DraftRepository.create({
      chapterNumber: 2,
      source: 'write',
      content: secondContent,
      wordCount: 8,
      sourceDependencies: [{ draftId: firstId, contentHash: sha256(firstContent) }],
    })
    const thirdId = DraftRepository.create({
      chapterNumber: 3,
      source: 'write',
      content: thirdContent,
      wordCount: 8,
      sourceDependencies: [{ draftId: secondId, contentHash: sha256(secondContent) }],
    })

    expect(DraftRepository.getMeta(thirdId)?.dependenciesStale).toBe(false)

    DraftRepository.updateContent(firstId, '第一章候选正文已变化。', 11)

    expect(DraftRepository.getMeta(secondId)?.dependenciesStale).toBe(true)
    expect(DraftRepository.getMeta(thirdId)?.dependenciesStale).toBe(true)
    expect(() => DraftRepository.create({
      chapterNumber: 4,
      source: 'write',
      content: '不应继承过期前史的第四章。',
      wordCount: 13,
      sourceDependencies: [{ draftId: thirdId, contentHash: sha256(thirdContent) }],
    })).toThrow('GENERATION_DRAFT_DEPENDENCY_STALE')
    expect(DraftRepository.listByChapter(4)).toEqual([])
  })

  it('fails closed for cyclic dependency metadata without recursing forever', () => {
    const firstContent = '第一章候选原文。'
    const secondContent = '第二章候选原文。'
    const firstId = DraftRepository.create({
      chapterNumber: 1, source: 'write', content: firstContent, wordCount: 8,
    })
    const secondId = DraftRepository.create({
      chapterNumber: 2,
      source: 'write',
      content: secondContent,
      wordCount: 8,
      sourceDependencies: [{ draftId: firstId, contentHash: sha256(firstContent) }],
    })
    getProjectDb()!.prepare('UPDATE drafts_all SET source_dependencies = ? WHERE id = ?').run(
      JSON.stringify([{ draftId: secondId, contentHash: sha256(secondContent) }]),
      firstId,
    )

    expect(DraftRepository.getMeta(firstId)?.dependenciesStale).toBe(true)
    expect(DraftRepository.getMeta(secondId)?.dependenciesStale).toBe(true)
    expect(() => DraftRepository.create({
      chapterNumber: 3,
      source: 'write',
      content: '不应继承环形前史的第三章。',
      wordCount: 13,
      sourceDependencies: [{ draftId: secondId, contentHash: sha256(secondContent) }],
    })).toThrow('GENERATION_DRAFT_DEPENDENCY_STALE')
  })

  it('historical fixture normalization (not production admission) treats legacy drafts as source-unknown without claiming stale evidence', () => {
    const sourceId = DraftRepository.create({
      chapterNumber: 1, source: 'write', content: '旧草稿。', wordCount: 4,
    })
    getProjectDb()!.exec('ALTER TABLE drafts_all DROP COLUMN source_dependencies')
    closeProjectDatabase()
    normalizeHistoricalFixture(projectRoot)

    expect(DraftRepository.getMeta(sourceId)).toMatchObject({
      sourceDependencies: [],
      dependenciesStale: false,
    })

    const downstreamId = DraftRepository.create({
      chapterNumber: 2,
      source: 'write',
      content: '基于旧草稿的新草稿。',
      wordCount: 10,
      sourceDependencies: [{ draftId: sourceId, contentHash: sha256('旧草稿。') }],
    })
    expect(DraftRepository.getMeta(downstreamId)?.dependenciesStale).toBe(false)
  })

  it('treats a current finalized source as confirmed history even when its own predecessor draft changed later', () => {
    const firstId = DraftRepository.create({ chapterNumber: 1, source: 'write', content: '第一章原稿。', wordCount: 6 })
    const secondContent = '第二章原稿。'
    const secondId = DraftRepository.create({
      chapterNumber: 2, source: 'write', content: secondContent, wordCount: 6,
      sourceDependencies: [{ kind: 'candidate', draftId: firstId, contentHash: sha256('第一章原稿。') }],
    })
    DraftRepository.updateContent(firstId, '第一章作者改过的稿。', 10)
    finalize(firstId, 1, '第一章作者改过的稿。', 'finalization-1')
    finalize(secondId, 2, secondContent, 'finalization-2')

    const thirdId = DraftRepository.create({
      chapterNumber: 3, source: 'write', content: '第三章正文。', wordCount: 6,
      sourceDependencies: [finalizedDependency(secondId, 2, secondContent, 'finalization-2')],
    })

    expect(DraftRepository.getMeta(secondId)?.dependenciesStale).toBe(true)
    expect(DraftRepository.getMeta(thirdId)?.dependenciesStale).toBe(false)
  })

  it('rejects an in-flight save after the frozen finalized source is replaced with identical prose', () => {
    const content = '不可变的第一章正文。'
    const sourceId = DraftRepository.create({
      chapterNumber: 1, source: 'write', content, wordCount: 10,
    })
    finalize(sourceId, 1, content, 'finalization-1')
    const dependency = finalizedDependency(sourceId, 1, content, 'finalization-1')

    const replacementId = reopenWithContent(1, content)
    finalize(replacementId, 1, content, 'finalization-2')

    expect(() => DraftRepository.create({
      chapterNumber: 2,
      source: 'write',
      content: '不应落盘的第二章。',
      wordCount: 9,
      sourceDependencies: [dependency],
    })).toThrow('GENERATION_DRAFT_DEPENDENCY_STALE')
    expect(DraftRepository.listByChapter(2)).toEqual([])
  })

  it('keeps a saved downstream draft but marks it stale when the source loses finalized identity', () => {
    const content = '第一章定稿正文保持不变。'
    const sourceId = DraftRepository.create({
      chapterNumber: 1, source: 'write', content, wordCount: 12,
    })
    finalize(sourceId, 1, content, 'finalization-1')
    const downstreamId = DraftRepository.create({
      chapterNumber: 2,
      source: 'write',
      content: '第二章正文。',
      wordCount: 6,
      sourceDependencies: [finalizedDependency(sourceId, 1, content, 'finalization-1')],
    })

    getProjectDb()!.prepare("UPDATE drafts_all SET status = 'archived' WHERE id = ?").run(sourceId)

    expect(DraftRepository.getMeta(downstreamId)).toMatchObject({
      id: downstreamId,
      dependenciesStale: true,
    })
  })

  it('keeps a saved downstream draft but marks it stale when finalized prose changes', () => {
    const content = '第一章定稿正文。'
    const sourceId = DraftRepository.create({
      chapterNumber: 1, source: 'write', content, wordCount: 9,
    })
    finalize(sourceId, 1, content, 'finalization-1')
    const downstreamId = DraftRepository.create({
      chapterNumber: 2,
      source: 'write',
      content: '第二章正文。',
      wordCount: 6,
      sourceDependencies: [finalizedDependency(sourceId, 1, content, 'finalization-1')],
    })
    const sourceContentId = getProjectDb()!.prepare('SELECT content_id AS contentId FROM drafts WHERE id = ?')
      .get(sourceId) as { contentId: number }

    getProjectDb()!.prepare('UPDATE contents SET body = ? WHERE id = ?')
      .run('第一章定稿正文已变更。', sourceContentId.contentId)

    expect(DraftRepository.getMeta(downstreamId)).toMatchObject({
      id: downstreamId,
      dependenciesStale: true,
    })
  })

  it('marks a saved downstream draft stale after same-prose replacement or source deletion', () => {
    const content = '第一章定稿正文。'
    const sourceId = DraftRepository.create({
      chapterNumber: 1, source: 'write', content, wordCount: 9,
    })
    finalize(sourceId, 1, content, 'finalization-1')
    const downstreamId = DraftRepository.create({
      chapterNumber: 2,
      source: 'write',
      content: '第二章正文。',
      wordCount: 6,
      sourceDependencies: [finalizedDependency(sourceId, 1, content, 'finalization-1')],
    })

    const replacementId = reopenWithContent(1, content)
    finalize(replacementId, 1, content, 'finalization-2')
    expect(DraftRepository.getMeta(downstreamId)?.dependenciesStale).toBe(true)

    getProjectDb()!.prepare('DELETE FROM drafts_all WHERE id = ?').run(sourceId)
    expect(DraftRepository.getFull(downstreamId)).toMatchObject({
      content: '第二章正文。',
      dependenciesStale: true,
    })
  })

  it('records receipt-less legacy finalized identity without inventing a receipt', () => {
    const content = '旧项目定稿正文。'
    const sourceId = DraftRepository.create({
      chapterNumber: 1, source: 'write', content, wordCount: 8,
    })
    getProjectDb()!.prepare("UPDATE drafts_all SET status = 'finalized' WHERE id = ?").run(sourceId)
    const dependency = {
      kind: 'legacy-finalized' as const,
      draftId: sourceId,
      chapterNumber: 1,
      contentHash: sha256(content),
    }
    const downstreamId = DraftRepository.create({
      chapterNumber: 2,
      source: 'write',
      content: '第二章正文。',
      wordCount: 6,
      sourceDependencies: [dependency],
    })

    expect(DraftRepository.getMeta(downstreamId)).toMatchObject({
      sourceDependencies: [dependency],
      dependenciesStale: false,
    })
  })
})
