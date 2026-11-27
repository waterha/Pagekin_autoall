import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ workers: [] as EventEmitter[], options: [] as unknown[] }))
vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter {
  constructor(_file: string, options: unknown) { super(); state.workers.push(this); state.options.push(options) }
} }))
import { runProjectOpenWorker } from '../project-open-worker-client'

afterEach(() => { state.workers.length = 0; state.options.length = 0 })
describe('background project verification', () => {
  it('waits for exact database and WAL identities without blocking the event loop', async () => {
    const result = { database: 'a'.repeat(64), wal: 'b'.repeat(64) }
    const pending = runProjectOpenWorker('open', 'fixture.db')
    let ticked = false
    await new Promise<void>(resolve => setImmediate(() => { ticked = true; resolve() }))
    expect(ticked).toBe(true)
    expect(state.options[0]).toEqual({ workerData: { operation: 'open', databasePath: 'fixture.db' } })
    state.workers[0].emit('message', { result })
    expect(await pending).toEqual(result)
  })
  it('preserves verifier failure codes', async () => {
    const pending = runProjectOpenWorker('open', 'fixture.db')
    state.workers[0].emit('message', { error: 'UNRECOGNIZED_SCHEMA' })
    await expect(pending).rejects.toThrow('UNRECOGNIZED_SCHEMA')
  })
  it('rejects malformed identity results and abnormal worker exits', async () => {
    const malformed = runProjectOpenWorker('identity', 'fixture.db')
    state.workers[0].emit('message', { result: { database: 'unknown' } })
    await expect(malformed).rejects.toThrow('PROJECT_DATABASE_WORKER_INVALID_RESULT')
    const stopped = runProjectOpenWorker('open', 'fixture.db')
    state.workers[1].emit('exit', 1)
    await expect(stopped).rejects.toThrow('PROJECT_DATABASE_WORKER_EXIT_1')
  })
})
