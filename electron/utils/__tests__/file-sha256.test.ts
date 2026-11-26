import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sha256FileSync } from '../file-sha256'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fileWith(bytes: Buffer): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-sha256-'))
  roots.push(root)
  const file = path.join(root, 'input.bin')
  fs.writeFileSync(file, bytes)
  return file
}

function fixtureBytes(length: number): Buffer {
  const bytes = Buffer.alloc(length)
  for (let index = 0; index < length; index++) bytes[index] = index % 251
  return bytes
}

describe('sha256FileSync', () => {
  it('hashes only the bytes actually returned by short reads until EOF', () => {
    const bytes = fixtureBytes(257)
    const file = fileWith(bytes)
    const actualRead = fs.readSync.bind(fs)
    const reads = vi.spyOn(fs, 'readSync').mockImplementation((
      descriptor: number, buffer: NodeJS.ArrayBufferView, options?: fs.ReadOptions | number,
      length?: number, position?: number | bigint | null,
    ) => {
      const offset = typeof options === 'number' ? options : options?.offset ?? 0
      const requested = length ?? (typeof options === 'object' ? options.length : undefined) ?? buffer.byteLength
      return actualRead(descriptor, buffer, offset, Math.min(requested, 7), position ?? null)
    })
    expect(sha256FileSync(file)).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(reads.mock.calls.length).toBeGreaterThan(30)
  })

  it('closes the opened descriptor when reading fails and propagates the read error', () => {
    const file = fileWith(fixtureBytes(31))
    const open = vi.spyOn(fs, 'openSync')
    const close = vi.spyOn(fs, 'closeSync')
    const failure = new Error('READ_FAILED')
    vi.spyOn(fs, 'readSync').mockImplementation(() => { throw failure })
    expect(() => sha256FileSync(file)).toThrow(failure)
    expect(open).toHaveBeenCalledWith(file, 'r')
    expect(close).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledWith(open.mock.results[0].value)
  })

  it('uses one bounded 1 MiB buffer for every read of a large file', () => {
    const file = fileWith(fixtureBytes(2 * 1024 * 1024 + 137))
    const reads = vi.spyOn(fs, 'readSync')
    sha256FileSync(file)
    expect(reads.mock.calls.length).toBeGreaterThan(3)
    const buffers = reads.mock.calls.map(([, buffer]) => buffer)
    expect(new Set(buffers).size).toBe(1)
    for (const buffer of buffers) expect(buffer.byteLength).toBeLessThanOrEqual(1024 * 1024)
  })

  it.each([0, 37, 2 * 1024 * 1024 + 137])('hashes all %i bytes identically to the SHA-256 reference', length => {
    const bytes = fixtureBytes(length)
    const file = fileWith(bytes)
    expect(sha256FileSync(file)).toBe(createHash('sha256').update(bytes).digest('hex'))
  })
})
