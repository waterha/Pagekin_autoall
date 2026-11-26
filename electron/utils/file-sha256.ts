import { createHash } from 'node:crypto'
import fs from 'node:fs'

/** Hash the complete file without retaining a file-sized Buffer in the main process. */
export function sha256FileSync(file: string): string {
  const descriptor = fs.openSync(file, 'r')
  try {
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    for (let bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null); bytes > 0;
      bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)) {
      hash.update(buffer.subarray(0, bytes))
    }
    return hash.digest('hex')
  } finally {
    fs.closeSync(descriptor)
  }
}
