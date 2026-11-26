import type Database from 'better-sqlite3'

const IDENTITY = `json_extract(binding_json,'$.projectId','$.epoch','$.sourceManifest.operation','$.sourceManifest.batchId','$.sourceManifest.batchIntent')`
const CACHE = 'pagekin_run_summary_cache'
const yieldToMain = () => new Promise<void>(resolve => setImmediate(resolve))
export interface GenerationSummaryRow { run_id: string; root_action_id: string; status: string; identity: string }

/** Connection-local derived data; never alter the portable project's schema or frozen sources. */
export class GenerationRunSummaries {
  private version: number
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${CACHE}(run_id TEXT PRIMARY KEY, root_action_id TEXT NOT NULL,
        status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, ordinal INTEGER NOT NULL, identity TEXT NOT NULL);
      CREATE TEMP TRIGGER IF NOT EXISTS pagekin_run_summary_update AFTER UPDATE OF binding_json,root_action_id,created_at_ms,run_id ON main.generation_runs
        BEGIN DELETE FROM ${CACHE} WHERE run_id=OLD.run_id; END;
      CREATE TEMP TRIGGER IF NOT EXISTS pagekin_run_summary_status AFTER UPDATE OF status ON main.generation_runs
        BEGIN UPDATE ${CACHE} SET status=NEW.status WHERE run_id=NEW.run_id; END;
      CREATE TEMP TRIGGER IF NOT EXISTS pagekin_run_summary_delete AFTER DELETE ON main.generation_runs
        BEGIN DELETE FROM ${CACHE} WHERE run_id=OLD.run_id; END;
      CREATE TEMP TRIGGER IF NOT EXISTS pagekin_run_summary_insert AFTER INSERT ON main.generation_runs
        BEGIN DELETE FROM ${CACHE} WHERE run_id=NEW.run_id; END;`)
    this.version = db.pragma('data_version', { simple: true }) as number
  }
  private invalidateExternalWrites(): void {
    const version = this.db.pragma('data_version', { simple: true }) as number
    if (version !== this.version) {
      this.db.exec(`DELETE FROM temp.${CACHE}`)
      this.version = version
    }
  }
  private missing(limit: number): string[] {
    // Only run_id can be read from the covering primary-key index. status and
    // created_at_ms follow the giant binding_json column in the row layout;
    // selecting either from every main row still traverses its overflow pages.
    return this.db.prepare(`SELECT r.run_id FROM generation_runs r LEFT JOIN temp.${CACHE} c ON c.run_id=r.run_id
      WHERE c.run_id IS NULL ORDER BY r.run_id LIMIT ?`).pluck().all(limit) as string[]
  }
  private fill(ids: string[]): void {
    if (!ids.length) return
    this.db.prepare(`INSERT OR REPLACE INTO temp.${CACHE}(run_id,root_action_id,status,created_at_ms,ordinal,identity)
      SELECT run_id,root_action_id,status,created_at_ms,rowid,${IDENTITY}
      FROM generation_runs WHERE run_id IN (${ids.map(() => '?').join(',')})`).run(...ids)
  }
  /** Warm old books in small batches so their first recovery read does not freeze the desktop. */
  async prepare(check: () => void): Promise<void> {
    for (;;) {
      check()
      this.invalidateExternalWrites()
      const ids = this.missing(8)
      if (!ids.length) return
      this.fill(ids)
      await yieldToMain()
    }
  }
  read(): GenerationSummaryRow[] {
    this.invalidateExternalWrites()
    for (let ids = this.missing(100); ids.length; ids = this.missing(100)) this.fill(ids)
    return this.db.prepare(`SELECT run_id,root_action_id,status,identity FROM temp.${CACHE}
      ORDER BY created_at_ms DESC, ordinal DESC`).all() as GenerationSummaryRow[]
  }
}
