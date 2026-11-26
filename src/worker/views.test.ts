import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CommitDetails, CommitRow, RefsResult, ViewState } from '../shared/protocol.ts'
import { createViewStore, filterKey } from './views.ts'

const row = (i: number): CommitRow => ({
  hash: i.toString(16).padStart(40, '0'),
  parents: [],
  author: 'A',
  email: 'a@example.com',
  authorTime: i,
  committer: 'A',
  commitTime: i,
  subject: `commit ${i}`,
  refs: []
})
const rows = (from: number, count: number) => Array.from({ length: count }, (_, i) => row(from + i))

function state(change: Partial<ViewState> = {}): ViewState {
  return {
    repo: { root: '/repo', name: 'repo', workspaceId: 'wt-1', head: { branch: 'main', hash: row(0).hash }, operation: null },
    stamp: { session: 's', refs: 1, worktree: 2 },
    filter: {},
    rowCount: 4,
    hasMore: true,
    uncommitted: 0,
    selected: [row(2).hash],
    uncommittedSelected: false,
    anchor: 2,
    cursor: 2,
    foldedHash: null,
    scrollTop: 120,
    expandedHeight: 96,
    ...change
  }
}

const refs = { head: { branch: 'main', hash: row(0).hash }, locals: [], remotes: [], tags: [] } as unknown as RefsResult
const details = (i: number) => ({ hash: row(i).hash, parents: [], files: [], message: `m${i}`, branches: [] }) as unknown as CommitDetails

test('a saved view comes back with the commits, refs and details it was served', () => {
  const store = createViewStore()
  store.recordPage('/repo', {}, 0, { commits: rows(0, 3), hasMore: true })
  store.recordPage('/repo', {}, 3, { commits: rows(2, 3), hasMore: true })
  store.recordRefs('/repo', refs)
  store.recordDetails('/repo', details(2))
  assert.equal(store.save('editor:/repo', state()), true)

  const view = store.load('editor:/repo')
  assert.deepEqual(view?.rows.map((r) => r.subject), ['commit 0', 'commit 1', 'commit 2', 'commit 3'], 'pages joined without repeats, cut to what was shown')
  assert.equal(view?.hasMore, true)
  assert.equal(view?.refs, refs)
  assert.equal(view?.details?.hash, row(2).hash)
  assert.equal(view?.scrollTop, 120)
  assert.equal(view?.expandedHeight, 96)
  assert.equal(view?.uncommittedFiles, null)
})

test('a first page starts the list again', () => {
  const store = createViewStore()
  store.recordPage('/repo', {}, 0, { commits: rows(0, 5), hasMore: false })
  store.recordPage('/repo', {}, 0, { commits: rows(10, 2), hasMore: false })
  store.save('k', state({ rowCount: 5 }))
  assert.deepEqual(store.load('k')?.rows.map((r) => r.subject), ['commit 10', 'commit 11'])
})

test('the commits are found whatever order the filter fields were set in', () => {
  assert.equal(filterKey({ text: 'a', regex: true }), filterKey({ regex: true, text: 'a' }))
  const store = createViewStore()
  store.recordPage('/repo', { text: 'a', regex: true }, 0, { commits: rows(0, 2), hasMore: false })
  store.save('k', state({ filter: { regex: true, text: 'a' }, rowCount: 2 }))
  assert.equal(store.load('k')?.rows.length, 2)
})

test('no view comes back when its commits are not here (another filter, or none served)', () => {
  const store = createViewStore()
  store.save('k', state())
  assert.equal(store.load('k'), null)
  store.recordPage('/repo', { text: 'other' }, 0, { commits: rows(0, 2), hasMore: false })
  assert.equal(store.load('k'), null)
  assert.equal(store.load('missing'), null)
})

test('details and uncommitted files are forgotten when they may have changed', () => {
  const store = createViewStore()
  store.recordPage('/repo', {}, 0, { commits: rows(0, 4), hasMore: false })
  store.recordDetails('/repo', details(2))
  store.recordUncommittedFiles('/repo', [{ status: 'M', path: 'a.ts' }])
  store.save('one', state())
  store.save('work', state({ selected: [], uncommittedSelected: true }))
  assert.deepEqual(store.load('work')?.uncommittedFiles, [{ status: 'M', path: 'a.ts' }])
  store.forgetDetails('/repo')
  store.forgetUncommitted('/repo')
  assert.equal(store.load('one')?.details, null)
  assert.equal(store.load('work')?.uncommittedFiles, null)
})

test('an invalid view is refused and only the newest few are kept', () => {
  const store = createViewStore()
  assert.equal(store.save('', state()), false)
  assert.equal(store.save('k', { repo: {} }), false)
  assert.equal(store.save(42, state()), false)
  store.recordPage('/repo', {}, 0, { commits: rows(0, 4), hasMore: false })
  for (let i = 0; i < 10; i++) store.save(`v${i}`, state())
  assert.equal(store.load('v0'), null)
  assert.ok(store.load('v9'))
})
