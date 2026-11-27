import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SqliteContentIdentity } from './sqlite-project-migration'

export function runProjectOpenWorker(operation: 'open' | 'identity', databasePath: string): Promise<SqliteContentIdentity> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(path.dirname(fileURLToPath(import.meta.url)), 'project-open-worker.js'), {
      workerData: { operation, databasePath },
    })
    let received = false
    worker.once('message', (message: { result?: SqliteContentIdentity; error?: string }) => {
      received = true
      if (message.error) reject(new Error(message.error))
      else if (message.result && /^[a-f0-9]{64}$/.test(message.result.database) && /^[a-f0-9]{64}$/.test(message.result.wal)) resolve(message.result)
      else reject(new Error('PROJECT_DATABASE_WORKER_INVALID_RESULT'))
    })
    worker.once('error', reject)
    worker.once('exit', code => {
      if (!received) reject(new Error(`PROJECT_DATABASE_WORKER_EXIT_${code}`))
    })
  })
}
