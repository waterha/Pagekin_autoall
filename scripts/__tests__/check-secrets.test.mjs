import { afterEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findSecrets, forbiddenCredentialPath } from '../check-secrets.mjs'

const script = fileURLToPath(new URL('../check-secrets.mjs', import.meta.url))
const roots = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'credential-guard-'))
  roots.push(root)
  const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  git('init', '-q')
  git('config', 'user.name', 'Credential guard tests')
  git('config', 'user.email', 'guard@example.invalid')
  const scan = (mode, input) => spawnSync(process.execPath, [script, mode], { cwd: root, windowsHide: true, encoding: 'utf8', input })
  const installHooks = () => {
    mkdirSync(path.join(root, 'scripts'))
    mkdirSync(path.join(root, '.githooks'))
    copyFileSync(script, path.join(root, 'scripts/check-secrets.mjs'))
    for (const name of ['pre-commit', 'pre-push']) {
      copyFileSync(fileURLToPath(new URL(`../../.githooks/${name}`, import.meta.url)), path.join(root, '.githooks', name))
    }
    git('config', 'core.hooksPath', '.githooks')
  }
  return { root, git, scan, installHooks }
}

describe('credential guard', () => {
  it('detects provider tokens, literal credentials and private keys without returning their values', () => {
    const token = ['sk', randomBytes(30).toString('hex')].join('-')
    const password = randomBytes(30).toString('base64url')
    const text = `const apiKey = '${token}'\nconst password = '${password}'\n${['-----BEGIN', 'PRIVATE KEY-----'].join(' ')}`
    const findings = findSecrets(text)
    expect(findings.map(item => item.rule)).toEqual(expect.arrayContaining(['provider-token', 'credential-literal', 'private-key']))
    expect(JSON.stringify(findings)).not.toContain(token)
    expect(JSON.stringify(findings)).not.toContain(password)
  })

  it('matches local actual credentials regardless of length, randomness, or test placeholder words', () => {
    const value = 'test-' + randomBytes(5).toString('hex')
    expect(findSecrets(`config=${value}`, [value]).map(item => item.rule)).toContain('local-config-credential')
    const binary = Buffer.concat([Buffer.from([0, 1, 0]), Buffer.from(value)])
    expect(findSecrets(binary, [value]).map(item => item.rule)).toContain('local-config-credential')
  })

  it.each(['.env', '.env.production', 'nested/.env.staging', 'private.pem', 'models.json', 'nested/models.json', 'backup.sqlite', 'project.db-wal', '.ai-novel/project.db', 'nested/credentials.json'])('blocks private path %s', file => {
    expect(forbiddenCredentialPath(file)).toBe(true)
  })

  it.each(['.env.example', '.env.template', 'src/shared/ipc-channels.ts', 'scripts/fixtures/v1/.vela/vela.db'])('allows source or explicit sample path %s', file => {
    expect(forbiddenCredentialPath(file)).toBe(false)
  })

  it('scans the staged blob even when the working copy has already been cleaned', () => {
    const f = fixture(), token = ['sk', randomBytes(30).toString('hex')].join('-')
    writeFileSync(path.join(f.root, 'source.js'), `const apiKey = '${token}'`)
    f.git('add', 'source.js')
    writeFileSync(path.join(f.root, 'source.js'), 'export const safe = true')
    const result = f.scan('--staged')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('source.js:1')
    expect(result.stderr + result.stdout).not.toContain(token)
  })

  it('finds credentials in old commits after deletion, including outgoing push history', () => {
    const f = fixture(), token = ['sk', randomBytes(30).toString('hex')].join('-')
    writeFileSync(path.join(f.root, 'old.js'), `const apiKey = '${token}'`)
    f.git('add', 'old.js'); f.git('commit', '-qm', 'old version')
    writeFileSync(path.join(f.root, 'old.js'), 'export const safe = true')
    f.git('add', 'old.js'); f.git('commit', '-qm', 'clean current version')
    expect(f.scan('--tracked').status).toBe(0)
    const history = f.scan('--history')
    expect(history.status).toBe(1)
    const head = f.git('rev-parse', 'HEAD').toString().trim()
    const push = f.scan('--push', `refs/heads/master ${head} refs/heads/master ${'0'.repeat(40)}\n`)
    expect(push.status).toBe(1)
    expect(push.stderr + history.stderr).not.toContain(token)
  })

  it('force-added private configuration is blocked even with no recognizable token', () => {
    const f = fixture()
    writeFileSync(path.join(f.root, '.env.production'), 'CONFIG=private')
    f.git('add', '.env.production')
    expect(f.scan('--staged').status).toBe(1)
  })

  it('the installed commit hook permits safe code and blocks a staged credential', () => {
    const f = fixture(), token = ['sk', randomBytes(30).toString('hex')].join('-')
    f.installHooks()
    writeFileSync(path.join(f.root, 'source.js'), 'export const safe = true')
    f.git('add', 'source.js'); f.git('commit', '-qm', 'safe source')
    writeFileSync(path.join(f.root, 'source.js'), `const apiKey = '${token}'`)
    f.git('add', 'source.js')
    const result = spawnSync('git', ['commit', '-qm', 'must be blocked'], { cwd: f.root, windowsHide: true, encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('<REDACTED>')
    expect(result.stdout + result.stderr).not.toContain(token)
    expect(f.git('log', '-1', '--format=%s').toString().trim()).toBe('safe source')
  })

  it('the installed push hook blocks historical credentials before a remote receives commits', () => {
    const f = fixture(), token = ['sk', randomBytes(30).toString('hex')].join('-')
    writeFileSync(path.join(f.root, 'source.js'), `const apiKey = '${token}'`)
    f.git('add', 'source.js'); f.git('commit', '-qm', 'historical fixture credential')
    writeFileSync(path.join(f.root, 'source.js'), 'export const safe = true')
    f.git('add', 'source.js'); f.git('commit', '-qm', 'clean current source')
    f.git('init', '--bare', '-q', 'remote.git')
    f.git('remote', 'add', 'origin', path.join(f.root, 'remote.git'))
    f.installHooks()
    const result = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/guard'], { cwd: f.root, windowsHide: true, encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('<REDACTED>')
    expect(result.stdout + result.stderr).not.toContain(token)
    expect(f.git('--git-dir=remote.git', 'rev-list', '--all').toString().trim()).toBe('')
  })

  it('reports failure outside a Git repository instead of passing silently', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'credential-guard-'))
    roots.push(root)
    const result = spawnSync(process.execPath, [script, '--tracked'], { cwd: root, encoding: 'utf8', windowsHide: true })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('blocked')
  })
})
