import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

// Reviewed fake credentials used by mocked/loopback tests, matched by exact value AND file.
// Local application credentials are always checked separately and cannot be exempted.
const FIXTURE_HASHES = {
  'electron/mcp/__tests__/mcp-manager.test.ts': ['bd60aff9abf6540e27ef6739148fc93b007e21d6ac8d173dbe80a711cc523b6e'],
  'scripts/__tests__/real-provider-generation-qualification.test.ts': ['09881f7b0db9cec1be51f767669c92a9499fb5be4abe3b6ed86da1d8dcf78151', '346ce5c52ce9db7357ab29606569d5be7756a50cdc9ba672f40af0958b29d9aa', '10754f80b9e2e863f9befda171acfa6ac6573f118e19f9ba52009081cac0d34b', '4f7589bf38e2be6817efdfa261b19d04d93125f7854cb456d7697fa9ce95eeeb'],
  'scripts/f04-v3-history-recovery-journey.mjs': ['f0733e34d864ba041e5d13fabc8b54d70e13163282226e5b2f235108f461a2df'],
  'scripts/f05-u12-confirmation-journey.mjs': ['0312fbbdc1fb958a87a05348299594fe49ed301204e2583cc1ccbe5913270c2c'],
  'scripts/f05-u13-history-seal-journey.mjs': ['3f73329bd268e82b9e112390a46217a9bfca15425ceaf09f07438e914b349e58'],
  'scripts/f05-u13-writer-journey.mjs': ['85451b107b2767fd1184b33eb7fe96549d456497948679ce141691bcadd29ec7'],
  'scripts/redesign/fake-model.mjs': ['1110ba1eb798b466f674156ff9c3bb6c92fe6fc9f24168cebff531149c371c79'],
  'src/services/generation/__tests__/generation-harness.test.ts': ['35a24baa34155dec08e0cc2cfe4360da60a68c162558c18313fdc396d75fecce'],
  'src/shared/__tests__/provider-presets.test.ts': ['5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8'],
  'src/stores/__tests__/llm-discovery-boundary.test.ts': ['ee2546cd691bacfb67eebac8963b504c03315a14e222b7ce6ffdbbde42afd4e1'],
  'electron/controllers/__tests__/llm-controller-connection.test.ts': ['5d9ebff49616e2f5bb672e45018d6a063bbbeeaeda318bcb32b33b8ce4ee4481', '1800df0bef08203a3913c8eda521ef19cfd58d9e701dcd9d0e90c1b0607bf395', 'fd81a718976ea7a933fe2450511e050dab7f1a50527f04844a6f367fc018e98d', '959759538618e867f05da708340a6b7de703d8ef5755abe884bd868ee05a16bc'],
}

function git(args, options = {}) {
  return execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...options })
}

function placeholder(value) {
  return /^(?:<.*>|\$\{.*\}|\{\{.*\}\})$/.test(value)
    || /(?:example|placeholder|synthetic|redacted|dummy|fake|your[-_]|test[-_]|[-_]test|fixture|sentinel)/i.test(value)
    || /^(?:sk-|ghp_|github_pat_)?([a-zA-Z0-9])\1{15,}$/.test(value)
}

function entropy(value) {
  const counts = new Map()
  for (const letter of value) counts.set(letter, (counts.get(letter) ?? 0) + 1)
  return [...counts.values()].reduce((sum, count) => sum - count / value.length * Math.log2(count / value.length), 0)
}

export function forbiddenCredentialPath(file) {
  const normalized = file.replaceAll('\\', '/')
  const base = path.posix.basename(normalized)
  return (/^\.env(?:\.|$)/i.test(base) && !/^\.env\.(?:example|sample|template)$/i.test(base))
    || /\.(?:pem|key|p12|pfx)$/i.test(base)
    || /^(?:credentials|secrets)\.json$/i.test(base)
    || base === 'models.json'
    || /\.(?:db(?:-(?:wal|shm))?|sqlite3?)$/i.test(base) && !normalized.startsWith('scripts/fixtures/')
    || /^(?:models|config|recent-projects)\.json$/i.test(normalized)
    || /(?:^|\/)(?:\.ai-novel|\.vela)\//.test(normalized) && !normalized.startsWith('scripts/fixtures/')
}

/** Findings contain only rule and line, never the matched credential or source line. */
export function findSecrets(content, knownSecrets = []) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : content
  const found = []
  const report = (rule, index, value = '') => found.push({ rule, line: text.slice(0, index).split('\n').length,
    fingerprint: createHash('sha256').update(value).digest('hex') })
  for (const value of knownSecrets) {
    if (value.length < 8) continue
    const index = text.indexOf(value)
    if (index >= 0) report('local-config-credential', index, value)
  }
  const patterns = [
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g],
    ['provider-token', /\b(?:sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[A-Z0-9]{16})\b/g],
    ['credential-literal', /["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["']([^"'\r\n]{16,})["']/gi],
    ['bearer-token', /\bBearer\s+([A-Za-z0-9._~+/-]{24,}={0,2})/g],
    ['url-credential', /https?:\/\/[^\s/:@]+:([^\s/@]{8,})@/g],
  ]
  for (const [rule, regex] of patterns) {
    for (const match of text.matchAll(regex)) {
      const value = match[1] ?? match[0]
      if (rule === 'private-key' || !placeholder(value) && (rule === 'url-credential' || entropy(value) >= 3.5)) report(rule, match.index, value)
    }
  }
  return found
}

/** Read only known application settings; values remain in memory and are never logged. */
function localCredentials() {
  const homes = [path.join(os.homedir(), '.vela')]
  if (process.env.APPDATA) homes.push(path.join(process.env.APPDATA, 'ai-novel-writer-data'), path.join(process.env.APPDATA, 'ai-novel-writer'))
  const values = new Set()
  function collect(value) {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)$/i.test(key)
        && typeof child === 'string' && child.length >= 8) values.add(child)
      else collect(child)
    }
  }
  function visit(directory, depth = 0) {
    if (depth > 5 || !existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory() && (depth > 0 || ['generations', 'data'].includes(entry.name))) visit(full, depth + 1)
      else if (entry.isFile() && ['models.json', 'config.json'].includes(entry.name)) {
        try { collect(JSON.parse(readFileSync(full, 'utf8'))) } catch { throw new Error('Could not read local credential settings safely.') }
      }
    }
  }
  for (const home of homes) visit(home)
  return [...values]
}

/** Stream Git objects without rendering file contents, including binary blobs and old versions. */
async function scanObjects(objects, knownSecrets, findings) {
  const child = spawn('git', ['cat-file', '--batch'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = objects.entries()
  let buffer = Buffer.alloc(0), current, size, count = 0
  const next = () => {
    const item = pending.next()
    if (item.done) { child.stdin.end(); return }
    current = item.value; size = undefined
    child.stdin.write(`${current[0]}\n`)
  }
  const exit = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error('Git object scan failed.')))
    child.stdout.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (size === undefined) {
          const end = buffer.indexOf(10)
          if (end < 0) return
          const header = buffer.subarray(0, end).toString('ascii').split(' ')
          if (header.length !== 3 || !/^\d+$/.test(header[2])) { child.kill(); reject(new Error('Invalid Git object response.')); return }
          size = Number(header[2]); buffer = buffer.subarray(end + 1)
          current[2] = header[1]
        }
        if (buffer.length < size + 1) return
        if (current[2] === 'blob' || current[2] === 'commit' || current[2] === 'tag') {
          for (const result of findSecrets(buffer.subarray(0, size), knownSecrets)) {
            if (result.rule !== 'local-config-credential' && FIXTURE_HASHES[current[1]]?.includes(result.fingerprint)) continue
            findings.push({ file: current[1] || `${current[2]} ${current[0].slice(0, 12)}`, ...result })
          }
          count++
        }
        buffer = buffer.subarray(size + 1)
        next()
        if (!buffer.length) return
      }
    })
    child.stderr.resume()
  })
  next()
  await exit
  return count
}

export async function checkSecrets(mode = '--tracked', pushInput = '') {
  const known = localCredentials(), findings = [], objects = new Map()
  if (mode === '--tracked' || mode === '--staged') {
    const entries = git(['ls-files', '--stage', '-z']).toString('utf8').split('\0').filter(Boolean)
    const changed = mode === '--staged' ? new Set(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).toString('utf8').split('\0')) : null
    for (const entry of entries) {
      const [, oid, , file] = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry).slice(1)
      if (changed && !changed.has(file)) continue
      if (forbiddenCredentialPath(file)) findings.push({ file, line: 1, rule: 'private-config-file' })
      objects.set(oid, file)
    }
  } else {
    let revisions = ['--all']
    if (mode === '--push') {
      revisions = pushInput.trim().split('\n').filter(Boolean).flatMap(line => {
        const [, local, , remote] = line.trim().split(/\s+/)
        if (/^0+$/.test(local)) return []
        if (!/^[a-f0-9]{40,64}$/.test(local) || !/^[a-f0-9]{40,64}$/.test(remote)) throw new Error('Invalid push reference.')
        return [local, ...(!/^0+$/.test(remote) && (() => { try { git(['cat-file', '-e', remote]); return true } catch { return false } })() ? [`^${remote}`] : [])]
      })
      if (!revisions.length) return { count: 0, findings: [] }
    }
    for (const line of git(['rev-list', '--objects', ...revisions]).toString('utf8').split('\n').filter(Boolean)) {
      const space = line.indexOf(' '), oid = space < 0 ? line : line.slice(0, space), file = space < 0 ? '' : line.slice(space + 1)
      objects.set(oid, file)
      if (file && forbiddenCredentialPath(file)) findings.push({ file, line: 1, rule: 'private-config-file' })
    }
  }
  return { count: await scanObjects(objects, known, findings), localCredentialCount: known.length, findings }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2] ?? '--tracked'
    if (!['--tracked', '--staged', '--history', '--push'].includes(mode)) throw new Error('Unknown scan mode.')
    const result = await checkSecrets(mode, mode === '--push' ? readFileSync(0, 'utf8') : '')
    for (const finding of result.findings) console.error(`${finding.file}:${finding.line} [${finding.rule}] <REDACTED>`)
    console.log(`Credential scan: ${result.count} objects checked; ${result.localCredentialCount ?? 0} local credentials compared locally; ${result.findings.length} findings. No credential values are printed.`)
    process.exitCode = result.findings.length ? 1 : 0
  } catch { console.error('Credential scan could not complete. Commit/push blocked; no credential values were printed.'); process.exitCode = 1 }
}
