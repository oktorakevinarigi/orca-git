import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import { installFakeOrcaCli } from './fake-orca-cli.test-util.ts'
import { fakeTerminals } from './fake-terminal.test-util.ts'
import * as main from './main.ts'
import { matchWorkspace, mentions } from './repo.ts'

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function fixture(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'git-log-worker-')))
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.name', 'Tester')
  sh(root, 'config', 'user.email', 'tester@example.com')
  sh(root, 'config', 'core.autocrlf', 'false')
  for (const name of ['one', 'two', 'three']) {
    writeFileSync(join(root, `${name}.txt`), name)
    sh(root, 'add', '.')
    sh(root, 'commit', '-qm', name)
  }
  return root
}

function host(root: string) {
  return mockHost({
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'demo', terminals: [] },
      'workspace.list': {
        workspaces: [
          { id: 'remote', kind: 'worktree', name: 'demo', path: '/nowhere/demo', branch: 'main', hostId: 'ssh-1' },
          { id: 'wt-1', kind: 'worktree', name: 'demo', path: root, branch: 'refs/heads/main', hostId: null }
        ],
        truncated: false
      },
      'editor.open': { opened: true }
    }
  })
}

test('resolves the focused workspace, pages the log and opens the editor tab', async () => {
  const root = fixture()
  try {
    const h = host(root)
    const worker = await mountWorker(main, { host: h })
    const resolved = await worker.request('repo.resolve', {})
    assert.equal(resolved.ok, true)
    assert.equal(resolved.ok && resolved.repo.root, root)
    assert.equal(resolved.ok && resolved.repo.workspaceId, 'wt-1')
    assert.equal(resolved.ok && resolved.repo.head.branch, 'main')

    const page = await worker.request('log.page', { root, filter: {}, skip: 0, limit: 2 })
    assert.deepEqual(page.commits.map((c: { subject: string }) => c.subject), ['three', 'two'])
    assert.equal(page.hasMore, true)

    const [newest, middle] = page.commits
    const run = await worker.request('action.run', { root, action: { kind: 'drop', hashes: [middle.hash] } })
    assert.equal(run.ok, true, run.message)
    assert.equal(run.previousHead, newest.hash)
    const posted = worker.posts.at(-1) as { event: string; payload: { root: string; stamp: { session: string; refs: number } } }
    assert.equal(posted.event, 'repo.changed')
    assert.equal(posted.payload.root, root)
    assert.equal(posted.payload.stamp.refs, 1, 'the change is counted')
    assert.deepEqual(await worker.request('repo.stamp', { root }), posted.payload.stamp)

    // The tab's file reads as "Git Log"; an earlier version's file goes, every *.gitlog stays out of git status.
    writeFileSync(join(root, '.orca-git-log.gitlog'), '{}')
    assert.deepEqual(await worker.request('tab.open', {}), { ok: true })
    assert.equal(main.ANCHOR, 'Git Log.gitlog')
    assert.deepEqual(h.callsOf('editor.open'), [{ workspaceId: 'wt-1', path: main.ANCHOR }])
    assert.equal(JSON.parse(readFileSync(join(root, main.ANCHOR), 'utf8')).root, root)
    assert.equal(existsSync(join(root, '.orca-git-log.gitlog')), false)
    assert.match(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8'), /^\*\.gitlog$/m)
    assert.equal(sh(root, 'status', '--porcelain'), '')

    await assert.rejects(worker.request('log.page', { root: tmpdir(), filter: {}, skip: 0 }))
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('the lookup brings back the first page and the change stamp; diffs are read once', async () => {
  const root = fixture()
  try {
    const worker = await mountWorker(main, { host: host(root) })
    const resolved = await worker.request('repo.resolve', { page: { filter: {}, limit: 2 } })
    assert.equal(resolved.ok, true)
    if (!resolved.ok) return
    assert.deepEqual(resolved.page?.commits.map((c: { subject: string }) => c.subject), ['three', 'two'])
    assert.equal(resolved.page?.hasMore, true)
    assert.deepEqual(resolved.stamp && { refs: resolved.stamp.refs, worktree: resolved.stamp.worktree }, { refs: 0, worktree: 0 })
    assert.deepEqual(await worker.request('repo.stamp', { root }), resolved.stamp)

    const filtered = await worker.request('repo.resolve', { root, page: { filter: { text: 'one' } } })
    assert.deepEqual(filtered.ok && filtered.page?.commits.map((c: { subject: string }) => c.subject), ['one'])
    const plain = await worker.request('repo.resolve', { root, page: 'nonsense' as never })
    assert.equal(plain.ok && plain.page, undefined, 'an invalid page request is ignored')

    // A view sends only what it shows; it comes back with the commits it was served.
    const more = await worker.request('log.page', { root, filter: {}, skip: 2, limit: 2 })
    assert.deepEqual(more.commits.map((c: { subject: string }) => c.subject), ['one'])
    const view = {
      repo: resolved.repo,
      stamp: resolved.stamp ?? null,
      filter: {},
      rowCount: 3,
      hasMore: false,
      uncommitted: 0,
      selected: [more.commits[0].hash],
      uncommittedSelected: false,
      anchor: 2,
      cursor: 2,
      foldedHash: null,
      scrollTop: 30,
      expandedHeight: 80
    }
    assert.deepEqual(await worker.request('view.save', { key: `editor:${root}`, state: view }), { ok: true })
    const back = await worker.request('view.load', { key: `editor:${root}` })
    assert.deepEqual(back?.rows.map((c: { subject: string }) => c.subject), ['three', 'two', 'one'])
    assert.equal(back?.expandedHeight, 80)

    // A commit's diff is read once: a rewritten file on disk does not change it.
    const newest = resolved.page!.commits[0]
    const ask = { root, hash: newest.hash, path: 'three.txt', wholeFile: true }
    const [first, second] = await Promise.all([worker.request('file.diff', ask), worker.request('file.diff', ask)])
    assert.deepEqual(first, second)
    assert.deepEqual(first.hunks[0].lines, [{ kind: '+', text: 'three', new: 1 }])

    // Uncommitted diffs change with the work tree: a change seen by the watcher reads them again.
    writeFileSync(join(root, 'one.txt'), 'uno')
    const worktreeAsk = { root, hash: '0'.repeat(40), path: 'one.txt' }
    const before = await worker.request('file.diff', worktreeAsk)
    assert.ok(before.hunks[0].lines.some((l: { kind: string; text: string }) => l.kind === '+' && l.text === 'uno'))
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('an untitled Git Log tab from the + menu shows the focused repository and keeps its file out of git status', async () => {
  const root = fixture()
  try {
    const worker = await mountWorker(main, { host: host(root) })
    // The + menu creates an empty "untitled.gitlog"; the tab finds the repository from the focus.
    writeFileSync(join(root, 'untitled.gitlog'), '')
    const panel = await worker.request('repo.resolve', {})
    assert.equal(panel.ok, true)
    assert.equal(sh(root, 'status', '--porcelain'), '?? untitled.gitlog', 'the side panel changes nothing')
    const tab = await worker.request('repo.resolve', {}, { panel: 'log-tab' })
    assert.equal(tab.ok && tab.repo.root, root)
    assert.equal(sh(root, 'status', '--porcelain'), '')
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('lists the uncommitted files, diffs them and opens a work-tree file in the editor', async () => {
  const root = fixture()
  try {
    const h = host(root)
    const worker = await mountWorker(main, { host: h })
    await worker.request('repo.resolve', {})
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'new.ts'), 'export {}\n')
    writeFileSync(join(root, 'one.txt'), 'uno')

    const { files } = await worker.request('repo.uncommittedFiles', { root })
    assert.deepEqual(files, [
      { status: 'M', path: 'one.txt' },
      { status: '?', path: 'src/new.ts' }
    ])
    assert.deepEqual(await worker.request('repo.uncommitted', { root }), { count: 2 })
    const diff = await worker.request('file.diff', { root, hash: '0'.repeat(40), path: 'src/new.ts' })
    assert.deepEqual(diff.hunks[0].lines, [{ kind: '+', text: 'export {}', new: 1 }])

    assert.deepEqual(await worker.request('file.open', { root, path: 'src/new.ts', workspaceId: 'wt-1' }), { ok: true })
    assert.deepEqual(h.callsOf('editor.open'), [{ workspaceId: 'wt-1', path: 'src/new.ts' }])
    assert.equal((await worker.request('file.open', { root, path: '../elsewhere.txt' })).ok, false)
    assert.equal((await worker.request('file.open', { root, path: 'missing.txt' })).ok, false)
    assert.equal(h.callsOf('editor.open').length, 1)
    await worker.deactivate()
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('a workspace on a remote host is read through a helper terminal, read-only', async () => {
  const root = fixture()
  try {
    writeFileSync(join(root, 'one.txt'), 'uno')
    const terminals = fakeTerminals()
    const h = mockHost({
      results: {
        ...terminals.results,
        'workspace.readContext': { branch: 'main', displayName: 'demo', terminals: [] },
        'workspace.list': {
          workspaces: [{ id: 'r', kind: 'worktree', name: 'demo', path: root, branch: 'main', hostId: 'runtime:server-1' }],
          truncated: false
        },
        'editor.open': { opened: true }
      }
    })
    const worker = await mountWorker(main, { host: h })
    const resolved = await worker.request('repo.resolve', {})
    assert.equal(resolved.ok, true, resolved.ok ? '' : resolved.reason)
    assert.equal(resolved.ok && resolved.repo.remote, true)
    assert.equal(resolved.ok && resolved.repo.workspaceId, 'r')
    assert.equal(resolved.ok && resolved.repo.head.branch, 'main')

    // Each round trip to a remote host is slow: the lookup and the whole first view take one.
    const typed = terminals.typed()
    assert.equal(typed, 1, 'the lookup and the first view went in one typed line')
    const [refs, firstPage, uncommitted] = await Promise.all([
      worker.request('repo.refs', { root }),
      worker.request('log.page', { root, filter: {}, skip: 0 }),
      worker.request('repo.uncommittedFiles', { root })
    ])
    assert.equal(terminals.typed(), typed, 'answered from what was fetched ahead')
    assert.equal(refs.head.branch, 'main')
    assert.equal(refs.uncommitted, 1)
    assert.equal(firstPage.commits.length, 3)
    assert.deepEqual(uncommitted.files, [{ status: 'M', path: 'one.txt' }])
    const details = await worker.request('commit.details', { root, hash: firstPage.commits[0].hash })
    assert.equal(details.files.length, 1)
    assert.equal(terminals.typed(), typed + 1, 'the details of one entry take one more')

    const page = await worker.request('log.page', { root, filter: {}, skip: 0, limit: 10 })
    assert.deepEqual(page.commits.map((c: { subject: string }) => c.subject), ['three', 'two', 'one'])
    assert.deepEqual((await worker.request('repo.uncommittedFiles', { root })).files, [{ status: 'M', path: 'one.txt' }])
    const diff = await worker.request('file.diff', { root, hash: '0'.repeat(40), path: 'one.txt' })
    assert.deepEqual(diff.hunks[0].lines.map((l: { kind: string; text: string }) => `${l.kind}${l.text}`), ['-one', '+uno'])

    // Opening a file goes through Orca, which reaches the remote host itself.
    assert.deepEqual(await worker.request('file.open', { root, path: 'one.txt' }), { ok: true })
    assert.deepEqual(h.callsOf('editor.open'), [{ workspaceId: 'r', path: 'one.txt' }])
    // A changed file opens in a diff tab, as it does locally: its small file is written on the host.
    const files = [{ status: 'A', path: 'three.txt' }]
    assert.deepEqual(await worker.request('diff.openTab', { root, hash: page.commits[0].hash, files, index: 0, workspaceId: 'r' }), { ok: true })
    const anchor = `.orca-git-log/three.txt @${page.commits[0].hash.slice(0, 8)}.gitdiff`
    assert.deepEqual(h.callsOf('editor.open').at(-1), { workspaceId: 'r', path: anchor })
    assert.deepEqual(JSON.parse(readFileSync(join(root, anchor), 'utf8')), { root, hash: page.commits[0].hash, files, index: 0 })
    assert.match(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8'), /^\.orca-git-log\/$/m)
    assert.equal(sh(root, 'status', '--porcelain'), 'M one.txt')
    // Nothing that changes the repository runs there.
    assert.deepEqual(await worker.request('repo.watch', { root }), { ok: false })
    assert.deepEqual(await worker.request('action.run', { root, action: { kind: 'fetch' } }), { ok: false, message: main.REMOTE_READ_ONLY })
    // The Git Log tab opens there too, from a small file written beside the project.
    assert.deepEqual(await worker.request('tab.open', {}), { ok: true })
    assert.deepEqual(h.callsOf('editor.open').at(-1), { workspaceId: 'r', path: main.ANCHOR })
    assert.deepEqual(JSON.parse(readFileSync(join(root, main.ANCHOR), 'utf8')), { root, workspaceId: 'r' })
    assert.equal(sh(root, 'status', '--porcelain'), 'M one.txt')
    assert.equal(terminals.open.size, 1)
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
    assert.equal(terminals.open.size, 0, 'the helper terminal closes with the plugin')
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('a paired Orca server workspace is found by its id, never as a same-named local copy, and reached with the orca command line', async () => {
  const server = fixture()
  const local = fixture()
  try {
    writeFileSync(join(server, 'two.txt'), 'dos')
    const cli = installFakeOrcaCli('env-1', [
      { id: `repo-1::${server}`, displayName: 'demo', path: server, branch: 'refs/heads/main', identity: { key: 'wt2:local:inst-1', instanceId: 'inst-1' } }
    ])
    // The window names the server workspace by a desktop identity that this computer's list lacks.
    const focused = 'identity:wt2:runtime:env-1:inst-1'
    let windowOpens = true
    const h = mockHost({
      results: {
        'workspace.readContext': { workspaceId: focused, branch: 'main', displayName: 'demo', terminals: [] },
        'workspace.list': {
          workspaces: [{ id: 'identity:wt2:local:copy', kind: 'worktree', name: 'demo', path: local, branch: 'main', hostId: 'local' }],
          truncated: false
        },
        'editor.open': () => {
          if (!windowOpens) throw Object.assign(new Error('This window does not list that workspace.'), { code: 'unavailable' })
          return { opened: true }
        }
      }
    })
    const worker = await mountWorker(main, { host: h })
    const resolved = await worker.request('repo.resolve', {})
    assert.equal(resolved.ok, true, resolved.ok ? '' : resolved.reason)
    assert.equal(resolved.ok && resolved.repo.root, server)
    assert.equal(resolved.ok && resolved.repo.remote, true)
    assert.equal(resolved.ok && resolved.repo.workspaceId, focused)
    const page = await worker.request('log.page', { root: server, filter: {}, skip: 0, limit: 10 })
    assert.deepEqual(page.commits.map((c: { subject: string }) => c.subject), ['three', 'two', 'one'])
    assert.deepEqual((await worker.request('repo.uncommittedFiles', { root: server })).files, [{ status: 'M', path: 'two.txt' }])
    assert.ok(cli.calls().some((args) => args.join(' ').startsWith('terminal create --environment env-1 --worktree identity:wt2:local:inst-1')))

    // Diff tab, Git Log tab and a file open in the window, on the server workspace.
    const files = [{ status: 'M', path: 'two.txt' }]
    assert.deepEqual(await worker.request('diff.openTab', { root: server, hash: '0'.repeat(40), files, index: 0, workspaceId: focused }), { ok: true })
    assert.deepEqual(h.callsOf('editor.open').at(-1), { workspaceId: focused, path: '.orca-git-log/two.txt (uncommitted).gitdiff' })
    assert.ok(readFileSync(join(server, '.orca-git-log', 'two.txt (uncommitted).gitdiff'), 'utf8').includes('"two.txt"'))
    assert.deepEqual(await worker.request('tab.open', { workspaceId: focused }), { ok: true })
    assert.deepEqual(JSON.parse(readFileSync(join(server, main.ANCHOR), 'utf8')), { root: server, workspaceId: focused })
    assert.equal(sh(server, 'status', '--porcelain'), 'M two.txt')
    // When the window cannot open it for a plugin, the command line opens it.
    windowOpens = false
    assert.deepEqual(await worker.request('file.open', { root: server, path: 'two.txt', workspaceId: focused }), { ok: true })
    assert.deepEqual(cli.opened(), [{ worktree: 'identity:wt2:local:inst-1', path: 'two.txt' }])

    // The same-named local copy was never touched.
    assert.equal(sh(local, 'status', '--porcelain'), '')
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
    assert.ok(cli.calls().some((args) => args[0] === 'terminal' && args[1] === 'close'))
  } finally {
    rmSync(server, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    rmSync(local, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('same-named workspaces are told apart by terminal titles, then by a previous choice', () => {
  const a = realpathSync.native(mkdtempSync(join(tmpdir(), 'git-log-a-')))
  const b = realpathSync.native(mkdtempSync(join(tmpdir(), 'git-log-b-')))
  mkdirSync(`${a}-sibling`)
  try {
    const list = [
      { id: 'a', name: 'main', path: a.replace(/\\/g, '/'), branch: 'main', hostId: 'local' },
      { id: 'a2', name: 'main', path: `${a}-sibling`, branch: 'main', hostId: 'local' },
      { id: 'b', name: 'main', path: b, branch: 'main', hostId: 'local' },
      { id: 'other', name: 'main', path: b, branch: 'feature', hostId: 'local' }
    ]
    const msys = (p: string) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)
    const context = (title: string) => ({ branch: 'main', displayName: 'main', terminals: [{ id: 't', title }] })

    assert.deepEqual(matchWorkspace(context(`MINGW64:${msys(b)}`), list), { workspace: list[2] })
    assert.deepEqual(matchWorkspace(context(`pwsh ${a}`), list), { workspace: list[0] })
    const unclear = matchWorkspace(context('Copilot'), list)
    assert.ok(unclear && 'ambiguous' in unclear)
    assert.deepEqual(unclear.ambiguous.map((w) => w.id), ['a', 'a2', 'b'])
    assert.deepEqual(matchWorkspace(context('Copilot'), list, 'b'), { workspace: list[2] })
  } finally {
    rmSync(a, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    rmSync(`${a}-sibling`, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    rmSync(b, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('terminal titles from a WSL shell name WSL workspaces by their Linux path', () => {
  const repo = '//wsl.localhost/ubuntu/home/me/xerox/tnr-auto'
  assert.ok(mentions('me@pc: ~/xerox/tnr-auto', repo))
  assert.ok(mentions('me@pc: /home/me/xerox/tnr-auto', repo))
  assert.ok(mentions('vim', '//wsl$/ubuntu/home/me/xerox/tnr-auto') === false)
  assert.ok(!mentions('me@pc: ~/xerox/tnr-auto-2', repo))
})