import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { fakeTerminals } from './fake-terminal.test-util.ts'
import { createGit } from './git.ts'
import { DIFF_DIR, remoteDiffAnchor } from './difftab.ts'
import { readFileDiff } from './diff.ts'
import { readDetails, readLogPage, readRefs, readUncommittedFiles, WORKTREE } from './log.ts'
import { operationInProgress } from './rebase.ts'
import { CHUNK_CHARS, createRemoteGit, readAnswer, RemoteShell, shellQuote, unpackResults } from './remote.ts'

const dirs: string[] = []
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const fast = { pollMs: 1, timeoutMs: 5000 }

function repo(count: number): string {
  const root = mkdtempSync(join(tmpdir(), 'git-log-remote-'))
  dirs.push(root)
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.name', 'Tester')
  sh(root, 'config', 'user.email', 'tester@example.com')
  sh(root, 'config', 'commit.gpgsign', 'false')
  for (let i = 1; i <= count; i++) {
    writeFileSync(join(root, `f${i}.txt`), `${i}\n`)
    sh(root, 'add', '.')
    sh(root, 'commit', '-qm', `c${i} it's "quoted" $HOME`)
  }
  return root
}

test('shell quoting keeps quotes, dollars and spaces literal', () => {
  const text = `a'b "c" $HOME \`x\` \\n`
  assert.equal(execFileSync('sh', ['-c', `printf %s ${shellQuote(text)}`], { encoding: 'utf8' }), text)
})

test('an answer is read between its own markers only, once the end marker is printed', () => {
  assert.equal(readAnswer(['GLBaaB 4', 'QUJD'], 'aa'), null)
  assert.deepEqual(readAnswer(['old', 'GLBbbB 9', 'x', 'GLBbbE', 'GLBaaB 4', 'QU', 'JD ', 'GLBaaE', 'me@host %'], 'aa'), { size: 4, text: 'QUJD' })
  assert.throws(() => readAnswer(['QUJD', 'GLBaaE'], 'aa'), /cut short/)
})

test('packed results split into each call output, error and exit code', () => {
  const body = Buffer.concat([Buffer.from('0 3 0\n128 0 5\n'), Buffer.from('abcfatal')])
  assert.deepEqual(unpackResults(gzipSync(body).toString('base64'), 2), [
    { ok: true, code: 0, stdout: 'abc', stderr: '' },
    { ok: false, code: 128, stdout: '', stderr: 'fatal' }
  ])
})

test('git on a remote host reads the same log, refs, details and diffs as local git', async () => {
  const root = repo(3)
  writeFileSync(join(root, 'f1.txt'), 'changed\n')
  writeFileSync(join(root, 'new file.txt'), 'untracked\n')
  const terminals = fakeTerminals()
  const shell = new RemoteShell(terminals, 'ws-remote', fast)
  const remote = createRemoteGit(shell, root)
  const local = createGit(root)

  assert.equal(remote.remote, true)
  assert.deepEqual(await readLogPage(remote, {}, 0, 50), await readLogPage(local, {}, 0, 50))
  assert.deepEqual(await readRefs(remote), await readRefs(local))
  const head = sh(root, 'rev-parse', 'HEAD')
  assert.deepEqual(await readDetails(remote, head), await readDetails(local, head))
  assert.deepEqual(await readUncommittedFiles(remote), await readUncommittedFiles(local))
  assert.deepEqual(await readFileDiff(remote, WORKTREE, 'new file.txt'), await readFileDiff(local, WORKTREE, 'new file.txt'))
  assert.equal(await operationInProgress(remote), null)
  assert.deepEqual(await remote.gitPathsExist(['HEAD', 'MERGE_HEAD']), [true, false])
  await assert.rejects(remote.out(['rev-parse', '--verify', 'no-such-ref']), /no-such-ref|Needed a single revision/)

  // One helper terminal for everything; calls made together share one typed line.
  assert.equal(terminals.open.size, 1)
  const before = terminals.typed()
  await Promise.all([remote.run(['rev-parse', 'HEAD']), remote.run(['config', 'user.name']), remote.run(['status', '--porcelain'])])
  assert.equal(terminals.typed() - before, 1)
  await shell.close()
  assert.equal(terminals.open.size, 0)
})

test('a large answer is read in pieces under the terminal read budget', async () => {
  const root = repo(1)
  // Random text compresses badly, so the packed answer spans several pieces.
  writeFileSync(join(root, 'big.txt'), Array.from({ length: 4000 }, (_, i) => `${i} ${Math.random().toString(36)}${Math.random().toString(36)}`).join('\n'))
  const terminals = fakeTerminals()
  const remote = createRemoteGit(new RemoteShell(terminals, 'ws', fast), root)
  const local = createGit(root)
  const before = terminals.typed()
  const diff = await readFileDiff(remote, WORKTREE, 'big.txt', undefined, true)
  assert.ok(terminals.typed() - before > 2, 'the answer took more than one read')
  assert.deepEqual(diff, await readFileDiff(local, WORKTREE, 'big.txt', undefined, true))
  assert.equal(diff.hunks[0].lines.length, 4000)
  assert.ok(CHUNK_CHARS < 32 * 1024)
})

test('a helper terminal the person closed is opened again', async () => {
  const root = repo(1)
  const terminals = fakeTerminals()
  const remote = createRemoteGit(new RemoteShell(terminals, 'ws', fast), root)
  assert.equal((await remote.out(['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'main')
  terminals.open.clear()
  assert.equal((await remote.out(['rev-parse', '--abbrev-ref', 'HEAD'])).trim(), 'main')
  assert.equal(terminals.open.size, 1)
})

test('a host that never answers fails with a clear error instead of hanging', async () => {
  const silent = { call: async (method: string) => (method === 'terminal.read' ? { lines: ['$'] } : { terminalId: 't', accepted: true }) }
  const remote = createRemoteGit(new RemoteShell(silent, 'ws', { pollMs: 1, timeoutMs: 30 }), '/somewhere')
  await assert.rejects(remote.run(['status']), /did not answer in time/)
})

test('a diff tab written on a remote host keeps the newest few dozen anchors and stays out of git status', async () => {
  const root = repo(1)
  const dir = join(root, DIFF_DIR)
  mkdirSync(dir)
  for (let i = 0; i < 45; i++) {
    writeFileSync(join(dir, `old ${i}.gitdiff`), '{}')
    utimesSync(join(dir, `old ${i}.gitdiff`), 1000 + i, 1000 + i)
  }
  const shell = new RemoteShell(fakeTerminals(), 'ws', fast)
  const req = { root, hash: 'a'.repeat(40), files: [{ status: 'M', path: "it's here.txt" }], index: 0, workspaceId: 'ws' }
  const anchor = remoteDiffAnchor(req)
  const result = await shell.run({ kind: 'sh', cwd: root, script: anchor.script })
  assert.equal(result.ok, true, result.stderr)
  assert.equal(anchor.path, `${DIFF_DIR}/it's here.txt @aaaaaaaa.gitdiff`)
  assert.deepEqual(JSON.parse(readFileSync(join(root, anchor.path), 'utf8')), { root, hash: req.hash, files: req.files, index: 0 })
  const left = readdirSync(dir)
  assert.equal(left.length, 40)
  assert.ok(left.includes(`it's here.txt @aaaaaaaa.gitdiff`) && !left.includes('old 0.gitdiff') && left.includes('old 44.gitdiff'))
  assert.equal(sh(root, 'status', '--porcelain'), '')
  // Running it again does not add the exclude line twice.
  await shell.run({ kind: 'sh', cwd: root, script: anchor.script })
  assert.equal(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8').split('\n').filter((line) => line === `${DIFF_DIR}/`).length, 1)
})
