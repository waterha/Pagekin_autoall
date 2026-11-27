import type Database from 'better-sqlite3'

const RUN_INDEX = 'pagekin_run_index'
const ATTEMPT_INDEX = 'pagekin_attempt_index'
const STATE_TABLE = 'pagekin_index_state'

const RUN_HAS_AUTHOR_EFFECT = `CASE WHEN json_valid(binding_json) AND json_type(binding_json,'$."$runEffects"') IS NOT NULL THEN 1 ELSE 0 END`
const RUN_IS_PRIVATE_PLANNING = `CASE WHEN json_valid(binding_json) AND json_extract(binding_json,'$.sourceManifest.policy.planning.outlineProtocol')='chapter-parts-v2' THEN 1 ELSE 0 END`
const RUN_FINALIZATION_SLOT_KEY = `CASE WHEN json_valid(binding_json) THEN json_extract(binding_json,'$.sourceManifest.finalizationGenerationSlotKey') END`
const RUN_HAS_BATCH_INTENT = `CASE WHEN json_valid(binding_json) AND json_extract(binding_json,'$.sourceManifest.batchIntent') IS NOT NULL THEN 1 ELSE 0 END`

const NEW_RUN_HAS_AUTHOR_EFFECT = `CASE WHEN json_valid(NEW.binding_json) AND json_type(NEW.binding_json,'$."$runEffects"') IS NOT NULL THEN 1 ELSE 0 END`
const NEW_RUN_IS_PRIVATE_PLANNING = `CASE WHEN json_valid(NEW.binding_json) AND json_extract(NEW.binding_json,'$.sourceManifest.policy.planning.outlineProtocol')='chapter-parts-v2' THEN 1 ELSE 0 END`
const NEW_RUN_FINALIZATION_SLOT_KEY = `CASE WHEN json_valid(NEW.binding_json) THEN json_extract(NEW.binding_json,'$.sourceManifest.finalizationGenerationSlotKey') END`
const NEW_RUN_HAS_BATCH_INTENT = `CASE WHEN json_valid(NEW.binding_json) AND json_extract(NEW.binding_json,'$.sourceManifest.batchIntent') IS NOT NULL THEN 1 ELSE 0 END`

const ATTEMPT_STATUS = `CASE WHEN json_valid(attempt_json) THEN json_extract(attempt_json,'$.status') END`
const ATTEMPT_PURPOSE = `CASE WHEN json_valid(usage_receipt_json) THEN json_extract(usage_receipt_json,'$.purpose') END`
const ATTEMPT_USAGE_VALID = `CASE WHEN json_valid(usage_receipt_json) THEN 1 ELSE 0 END`
const ATTEMPT_REVIEW_KIND = `CASE WHEN json_valid(usage_receipt_json) THEN json_extract(usage_receipt_json,'$.reviewRevisionEffect.kind') END`
const ATTEMPT_REVIEW_ID = `CASE WHEN json_valid(usage_receipt_json) THEN json_extract(usage_receipt_json,'$.reviewRevisionEffect.id') END`
const ATTEMPT_DRAFT_ID = `CASE WHEN json_valid(usage_receipt_json) THEN json_extract(usage_receipt_json,'$.draftCommit.id') END`
const ATTEMPT_DRAFT_CHAPTER = `CASE WHEN json_valid(usage_receipt_json) THEN json_extract(usage_receipt_json,'$.draftCommit.chapterNumber') END`
const ATTEMPT_DRAFT_BATCH = `CASE WHEN json_valid(usage_receipt_json) THEN json_extract(usage_receipt_json,'$.draftCommit.batchId') END`

const NEW_ATTEMPT_STATUS = `CASE WHEN json_valid(NEW.attempt_json) THEN json_extract(NEW.attempt_json,'$.status') END`
const NEW_ATTEMPT_PURPOSE = `CASE WHEN json_valid(NEW.usage_receipt_json) THEN json_extract(NEW.usage_receipt_json,'$.purpose') END`
const NEW_ATTEMPT_USAGE_VALID = `CASE WHEN json_valid(NEW.usage_receipt_json) THEN 1 ELSE 0 END`
const NEW_ATTEMPT_REVIEW_KIND = `CASE WHEN json_valid(NEW.usage_receipt_json) THEN json_extract(NEW.usage_receipt_json,'$.reviewRevisionEffect.kind') END`
const NEW_ATTEMPT_REVIEW_ID = `CASE WHEN json_valid(NEW.usage_receipt_json) THEN json_extract(NEW.usage_receipt_json,'$.reviewRevisionEffect.id') END`
const NEW_ATTEMPT_DRAFT_ID = `CASE WHEN json_valid(NEW.usage_receipt_json) THEN json_extract(NEW.usage_receipt_json,'$.draftCommit.id') END`
const NEW_ATTEMPT_DRAFT_CHAPTER = `CASE WHEN json_valid(NEW.usage_receipt_json) THEN json_extract(NEW.usage_receipt_json,'$.draftCommit.chapterNumber') END`
const NEW_ATTEMPT_DRAFT_BATCH = `CASE WHEN json_valid(NEW.usage_receipt_json) THEN json_extract(NEW.usage_receipt_json,'$.draftCommit.batchId') END`

export interface IndexedActiveAttempt {
  attempt_id: string
  attempt_json: string
  root_action_id: string
  status: string
}

export interface IndexedRunAttemptSummary {
  attemptId: string
  invocationNonce: string
  status: string
  purpose: string
}

export interface IndexedAttemptReceiptRow {
  attempt_id: string
  run_id: string
  usage_receipt_json: string
}

export interface IndexedBatchCommitRow extends IndexedAttemptReceiptRow {
  batch_id: string
}

/**
 * Connection-local TEMP index tables and triggers for `generation_runs` and `generation_attempts`.
 * Never modifies the portable project's `main` schema or `sqlite_master` fingerprint.
 */
export class GenerationLedgerIndex {
  private initializedOutsideTx = false
  private lastSafeOutsideTx = false
  private lastSafeVersion = -1

  constructor(private readonly db: Database.Database) {
    this.ensureInitialized()
  }

  private ensureInitialized(): boolean {
    if (this.initializedOutsideTx) return true
    const sourceCount = this.db
      .prepare("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('generation_runs','generation_attempts')")
      .pluck()
      .get() as number
    if (sourceCount < 2) return false

    const tempCount = this.db
      .prepare(`SELECT COUNT(*) FROM sqlite_temp_master WHERE type='table' AND name IN ('${RUN_INDEX}','${ATTEMPT_INDEX}','${STATE_TABLE}')`)
      .pluck()
      .get() as number
    if (tempCount === 3) {
      if (!this.db.inTransaction) this.initializedOutsideTx = true
      return true
    }

    this.lastSafeOutsideTx = false
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS ${STATE_TABLE} (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data_version INTEGER NOT NULL
      );

      CREATE TEMP TABLE IF NOT EXISTS ${RUN_INDEX} (
        run_id TEXT PRIMARY KEY,
        root_action_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        has_author_effect INTEGER NOT NULL,
        is_private_planning INTEGER NOT NULL,
        finalization_slot_key TEXT,
        has_batch_intent INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS temp.idx_pagekin_run_root
        ON ${RUN_INDEX}(root_action_id, ordinal);
      CREATE INDEX IF NOT EXISTS temp.idx_pagekin_run_fin_slot
        ON ${RUN_INDEX}(finalization_slot_key, ordinal)
        WHERE finalization_slot_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS temp.idx_pagekin_run_batch
        ON ${RUN_INDEX}(has_batch_intent)
        WHERE has_batch_intent = 1;

      CREATE TEMP TRIGGER IF NOT EXISTS pagekin_run_index_insert
        AFTER INSERT ON main.generation_runs
        BEGIN
          INSERT OR REPLACE INTO ${RUN_INDEX}(
            run_id, root_action_id, ordinal, has_author_effect, is_private_planning, finalization_slot_key, has_batch_intent
          ) VALUES (
            NEW.run_id, NEW.root_action_id, NEW.rowid,
            ${NEW_RUN_HAS_AUTHOR_EFFECT}, ${NEW_RUN_IS_PRIVATE_PLANNING}, ${NEW_RUN_FINALIZATION_SLOT_KEY}, ${NEW_RUN_HAS_BATCH_INTENT}
          );
        END;
      CREATE TEMP TRIGGER IF NOT EXISTS pagekin_run_index_update
        AFTER UPDATE OF run_id, root_action_id, binding_json ON main.generation_runs
        BEGIN
          DELETE FROM ${RUN_INDEX} WHERE run_id = OLD.run_id;
          INSERT OR REPLACE INTO ${RUN_INDEX}(
            run_id, root_action_id, ordinal, has_author_effect, is_private_planning, finalization_slot_key, has_batch_intent
          ) VALUES (
            NEW.run_id, NEW.root_action_id, NEW.rowid,
            ${NEW_RUN_HAS_AUTHOR_EFFECT}, ${NEW_RUN_IS_PRIVATE_PLANNING}, ${NEW_RUN_FINALIZATION_SLOT_KEY}, ${NEW_RUN_HAS_BATCH_INTENT}
          );
        END;
      CREATE TEMP TRIGGER IF NOT EXISTS pagekin_run_index_delete
        AFTER DELETE ON main.generation_runs
        BEGIN
          DELETE FROM ${RUN_INDEX} WHERE run_id = OLD.run_id;
        END;

      CREATE TEMP TABLE IF NOT EXISTS ${ATTEMPT_INDEX} (
        attempt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        root_action_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        status TEXT,
        purpose TEXT,
        usage_valid INTEGER NOT NULL,
        review_effect_kind TEXT,
        review_effect_id INTEGER,
        draft_commit_id INTEGER,
        draft_commit_chapter INTEGER,
        draft_commit_batch_id TEXT
      );
      CREATE INDEX IF NOT EXISTS temp.idx_pagekin_att_root
        ON ${ATTEMPT_INDEX}(root_action_id, ordinal);
      CREATE INDEX IF NOT EXISTS temp.idx_pagekin_att_run
        ON ${ATTEMPT_INDEX}(run_id, ordinal);
      CREATE INDEX IF NOT EXISTS temp.idx_pagekin_att_active
        ON ${ATTEMPT_INDEX}(status, ordinal)
        WHERE status IN ('reserved', 'dispatch-marked');
      CREATE INDEX IF NOT EXISTS temp.idx_pagekin_att_review
        ON ${ATTEMPT_INDEX}(review_effect_kind, review_effect_id, ordinal)
        WHERE review_effect_kind IS NOT NULL;
      CREATE INDEX IF NOT EXISTS temp.idx_pagekin_att_draft
        ON ${ATTEMPT_INDEX}(draft_commit_id, draft_commit_chapter)
        WHERE draft_commit_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS temp.idx_pagekin_att_batch
        ON ${ATTEMPT_INDEX}(draft_commit_batch_id, ordinal)
        WHERE draft_commit_batch_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS temp.idx_pagekin_att_invalid
        ON ${ATTEMPT_INDEX}(usage_valid)
        WHERE usage_valid = 0;

      CREATE TEMP TRIGGER IF NOT EXISTS pagekin_attempt_index_insert
        AFTER INSERT ON main.generation_attempts
        BEGIN
          INSERT OR REPLACE INTO ${ATTEMPT_INDEX}(
            attempt_id, run_id, root_action_id, ordinal, status, purpose, usage_valid,
            review_effect_kind, review_effect_id, draft_commit_id, draft_commit_chapter, draft_commit_batch_id
          ) VALUES (
            NEW.attempt_id, NEW.run_id, NEW.root_action_id, NEW.rowid,
            ${NEW_ATTEMPT_STATUS}, ${NEW_ATTEMPT_PURPOSE}, ${NEW_ATTEMPT_USAGE_VALID},
            ${NEW_ATTEMPT_REVIEW_KIND}, ${NEW_ATTEMPT_REVIEW_ID},
            ${NEW_ATTEMPT_DRAFT_ID}, ${NEW_ATTEMPT_DRAFT_CHAPTER}, ${NEW_ATTEMPT_DRAFT_BATCH}
          );
        END;
      CREATE TEMP TRIGGER IF NOT EXISTS pagekin_attempt_index_update
        AFTER UPDATE OF attempt_id, run_id, root_action_id, attempt_json, usage_receipt_json ON main.generation_attempts
        BEGIN
          DELETE FROM ${ATTEMPT_INDEX} WHERE attempt_id = OLD.attempt_id;
          INSERT OR REPLACE INTO ${ATTEMPT_INDEX}(
            attempt_id, run_id, root_action_id, ordinal, status, purpose, usage_valid,
            review_effect_kind, review_effect_id, draft_commit_id, draft_commit_chapter, draft_commit_batch_id
          ) VALUES (
            NEW.attempt_id, NEW.run_id, NEW.root_action_id, NEW.rowid,
            ${NEW_ATTEMPT_STATUS}, ${NEW_ATTEMPT_PURPOSE}, ${NEW_ATTEMPT_USAGE_VALID},
            ${NEW_ATTEMPT_REVIEW_KIND}, ${NEW_ATTEMPT_REVIEW_ID},
            ${NEW_ATTEMPT_DRAFT_ID}, ${NEW_ATTEMPT_DRAFT_CHAPTER}, ${NEW_ATTEMPT_DRAFT_BATCH}
          );
        END;
      CREATE TEMP TRIGGER IF NOT EXISTS pagekin_attempt_index_delete
        AFTER DELETE ON main.generation_attempts
        BEGIN
          DELETE FROM ${ATTEMPT_INDEX} WHERE attempt_id = OLD.attempt_id;
        END;
    `)
    if (!this.db.inTransaction) this.initializedOutsideTx = true
    return true
  }

  /** Rebuild TEMP indexes on first use or when an external SQLite connection committed writes. */
  sync(): void {
    const version = this.db.pragma('data_version', { simple: true }) as number
    if (this.initializedOutsideTx && this.lastSafeOutsideTx && version === this.lastSafeVersion) return
    if (!this.ensureInitialized()) return

    const recordedVersion = this.db
      .prepare(`SELECT data_version FROM temp.${STATE_TABLE} WHERE id = 1`)
      .pluck()
      .get() as number | undefined
    if (recordedVersion === version) {
      if (!this.db.inTransaction) {
        this.initializedOutsideTx = true
        this.lastSafeOutsideTx = true
        this.lastSafeVersion = version
      }
      return
    }

    this.lastSafeOutsideTx = false
    this.db.exec(`
      DELETE FROM temp.${RUN_INDEX};
      INSERT INTO temp.${RUN_INDEX}(
        run_id, root_action_id, ordinal, has_author_effect, is_private_planning, finalization_slot_key, has_batch_intent
      )
      SELECT run_id, root_action_id, rowid,
        ${RUN_HAS_AUTHOR_EFFECT}, ${RUN_IS_PRIVATE_PLANNING}, ${RUN_FINALIZATION_SLOT_KEY}, ${RUN_HAS_BATCH_INTENT}
      FROM main.generation_runs;

      DELETE FROM temp.${ATTEMPT_INDEX};
      INSERT INTO temp.${ATTEMPT_INDEX}(
        attempt_id, run_id, root_action_id, ordinal, status, purpose, usage_valid,
        review_effect_kind, review_effect_id, draft_commit_id, draft_commit_chapter, draft_commit_batch_id
      )
      SELECT attempt_id, run_id, root_action_id, rowid,
        ${ATTEMPT_STATUS}, ${ATTEMPT_PURPOSE}, ${ATTEMPT_USAGE_VALID},
        ${ATTEMPT_REVIEW_KIND}, ${ATTEMPT_REVIEW_ID},
        ${ATTEMPT_DRAFT_ID}, ${ATTEMPT_DRAFT_CHAPTER}, ${ATTEMPT_DRAFT_BATCH}
      FROM main.generation_attempts;
    `)
    this.db.prepare(`INSERT OR REPLACE INTO temp.${STATE_TABLE}(id, data_version) VALUES(1, ?)`).run(version)
    if (!this.db.inTransaction) {
      this.initializedOutsideTx = true
      this.lastSafeOutsideTx = true
      this.lastSafeVersion = version
    }
  }

  hasAuthorEffectForRoot(rootId: string): boolean {
    this.sync()
    return !!this.db
      .prepare(`SELECT 1 FROM temp.${RUN_INDEX} WHERE root_action_id=? AND has_author_effect=1 LIMIT 1`)
      .get(rootId)
  }

  isPrivatePlanningHistory(runId: string): boolean {
    this.sync()
    return !!this.db
      .prepare(`SELECT 1 FROM temp.${RUN_INDEX} WHERE root_action_id=(SELECT root_action_id FROM temp.${RUN_INDEX} WHERE run_id=?) AND is_private_planning=1 LIMIT 1`)
      .get(runId)
  }

  runRootActionId(runId: string): string | undefined {
    this.sync()
    const row = this.db
      .prepare(`SELECT root_action_id FROM temp.${RUN_INDEX} WHERE run_id=?`)
      .pluck()
      .get(runId)
    return typeof row === 'string' ? row : undefined
  }

  firstRunIdForRoot(rootId: string): string | undefined {
    this.sync()
    const row = this.db
      .prepare(`SELECT run_id FROM temp.${RUN_INDEX} WHERE root_action_id=? ORDER BY ordinal LIMIT 1`)
      .pluck()
      .get(rootId)
    return typeof row === 'string' ? row : undefined
  }

  runIdsForRoot(rootId: string): string[] {
    this.sync()
    return this.db
      .prepare(`SELECT run_id FROM temp.${RUN_INDEX} WHERE root_action_id=? ORDER BY ordinal`)
      .pluck()
      .all(rootId) as string[]
  }

  finalizationSlotRunIds(slotKey: string): string[] {
    this.sync()
    return this.db
      .prepare(`SELECT run_id FROM temp.${RUN_INDEX} WHERE finalization_slot_key=? ORDER BY ordinal`)
      .pluck()
      .all(slotKey) as string[]
  }

  activeBatchIntentRunIds(): string[] {
    this.sync()
    return this.db
      .prepare(`SELECT i.run_id
        FROM temp.${RUN_INDEX} i
        JOIN main.generation_roots g ON g.root_action_id = i.root_action_id
        WHERE i.has_batch_intent = 1
          AND COALESCE(CASE WHEN json_valid(g.action_json) THEN json_extract(g.action_json,'$.status') END,'') NOT IN ('cancelled','sealed')
          AND g.blocked_code IS NULL
        ORDER BY i.ordinal`)
      .pluck()
      .all() as string[]
  }

  attemptJsonsForRoot(rootId: string): { attempt_json: string }[] {
    this.sync()
    return this.db
      .prepare(`SELECT a.attempt_json
        FROM temp.${ATTEMPT_INDEX} i
        JOIN main.generation_attempts a ON a.attempt_id = i.attempt_id
        WHERE i.root_action_id = ?
        ORDER BY i.ordinal`)
      .all(rootId) as { attempt_json: string }[]
  }

  attemptCountForRun(runId: string): number {
    this.sync()
    return this.db
      .prepare(`SELECT COUNT(*) FROM temp.${ATTEMPT_INDEX} WHERE run_id=?`)
      .pluck()
      .get(runId) as number
  }

  activeAttempts(): IndexedActiveAttempt[] {
    this.sync()
    return this.db
      .prepare(`SELECT i.attempt_id, a.attempt_json, i.root_action_id, i.status
        FROM temp.${ATTEMPT_INDEX} i
        JOIN main.generation_attempts a ON a.attempt_id = i.attempt_id
        WHERE i.status IN ('reserved', 'dispatch-marked')
        ORDER BY i.ordinal`)
      .all() as IndexedActiveAttempt[]
  }

  hasInFlightAttempt(): boolean {
    this.sync()
    return !!this.db
      .prepare(`SELECT 1 FROM temp.${ATTEMPT_INDEX} WHERE status IN ('reserved', 'dispatch-marked') LIMIT 1`)
      .get()
  }

  hasInFlightAttemptForRun(runId: string): boolean {
    this.sync()
    return !!this.db
      .prepare(`SELECT 1 FROM temp.${ATTEMPT_INDEX} WHERE run_id=? AND status IN ('reserved', 'dispatch-marked') LIMIT 1`)
      .get(runId)
  }

  attemptPurpose(attemptId: string): string | undefined {
    this.sync()
    const value = this.db
      .prepare(`SELECT purpose FROM temp.${ATTEMPT_INDEX} WHERE attempt_id=?`)
      .pluck()
      .get(attemptId)
    return value === null || value === undefined ? undefined : String(value)
  }

  runAttemptSummaries(runId: string): IndexedRunAttemptSummary[] {
    this.sync()
    const rows = this.db
      .prepare(`SELECT i.attempt_id, a.invocation_nonce, i.status, i.purpose
        FROM temp.${ATTEMPT_INDEX} i
        JOIN main.generation_attempts a ON a.attempt_id = i.attempt_id
        WHERE i.run_id = ?
        ORDER BY i.ordinal`)
      .all(runId) as { attempt_id: string; invocation_nonce: string; status: string | null; purpose: string | null }[]
    return rows.map(row => ({
      attemptId: row.attempt_id,
      invocationNonce: row.invocation_nonce,
      status: String(row.status),
      purpose: String(row.purpose ?? 'unknown'),
    }))
  }

  reviewEffectAttempts(kind: 'review' | 'revision', id: number): IndexedAttemptReceiptRow[] {
    this.sync()
    return this.db
      .prepare(`SELECT i.attempt_id, i.run_id, a.usage_receipt_json
        FROM temp.${ATTEMPT_INDEX} i
        JOIN main.generation_attempts a ON a.attempt_id = i.attempt_id
        WHERE i.review_effect_kind = ? AND i.review_effect_id = ?
        ORDER BY i.ordinal`)
      .all(kind, id) as IndexedAttemptReceiptRow[]
  }

  draftCommitBindings(draftId: number, chapterNumber: number): string[] {
    this.sync()
    return this.db
      .prepare(`SELECT r.binding_json
        FROM temp.${ATTEMPT_INDEX} i
        JOIN main.generation_runs r ON r.run_id = i.run_id
        WHERE i.draft_commit_id = ? AND i.draft_commit_chapter = ?
        ORDER BY i.ordinal`)
      .pluck()
      .all(draftId, chapterNumber) as string[]
  }

  batchCommitRows(batchId?: string): IndexedBatchCommitRow[] {
    this.sync()
    if (batchId === undefined) {
      return this.db
        .prepare(`SELECT i.attempt_id, i.run_id, a.usage_receipt_json, i.draft_commit_batch_id AS batch_id
          FROM temp.${ATTEMPT_INDEX} i
          JOIN main.generation_attempts a ON a.attempt_id = i.attempt_id
          WHERE i.draft_commit_batch_id IS NOT NULL
          ORDER BY i.ordinal`)
        .all() as IndexedBatchCommitRow[]
    }
    return this.db
      .prepare(`SELECT i.attempt_id, i.run_id, a.usage_receipt_json, i.draft_commit_batch_id AS batch_id
        FROM temp.${ATTEMPT_INDEX} i
        JOIN main.generation_attempts a ON a.attempt_id = i.attempt_id
        WHERE i.draft_commit_batch_id = ?
        ORDER BY i.ordinal`)
      .all(batchId) as IndexedBatchCommitRow[]
  }

  invalidUsageReceiptCount(): number {
    this.sync()
    return this.db
      .prepare(`SELECT COUNT(*) FROM temp.${ATTEMPT_INDEX} WHERE usage_valid = 0`)
      .pluck()
      .get() as number
  }
}

const connectionIndexes = new WeakMap<Database.Database, GenerationLedgerIndex>()

/** Returns the shared connection-local ledger index for `db`. */
export function getGenerationLedgerIndex(db: Database.Database): GenerationLedgerIndex {
  let index = connectionIndexes.get(db)
  if (!index) {
    index = new GenerationLedgerIndex(db)
    connectionIndexes.set(db, index)
  }
  return index
}
