import { parentPort, workerData } from 'node:worker_threads'
import { openProjectSqlite, readSqliteContentIdentity } from './sqlite-project-migration'

/** The same verification/migration lane, isolated from the desktop's event loop. */
try {
  const result = workerData.operation === 'open'
    ? openProjectSqlite({ databasePath: workerData.databasePath })
    : readSqliteContentIdentity(workerData.databasePath)
  parentPort!.postMessage({ result })
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : 'PROJECT_DATABASE_OPEN_FAILED' })
}
