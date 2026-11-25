import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeGraph, graphLanes, graphSvg, LANE_WIDTH } from './graph.ts'
import { reachableFrom, refLabels, relativeDate } from './format.ts'
import { changeBlocks, changedRange, splitRows } from './diffmodel.ts'
import { markSpan } from './ruler.ts'
import { buildFileTree } from './filetree.ts'

const row = (hash: string, ...parents: string[]) => ({ hash, parents })

test('a straight history stays in lane 0 with one color', () => {
  const graph = computeGraph([row('c', 'b'), row('b', 'a'), row('a')])
  assert.deepEqual(graph.map((g) => [g.lane, g.color, g.width]), [[0, 0, 1], [0, 0, 1], [0, 0, 1]])
  assert.deepEqual(graph[0].incoming, [])
  assert.deepEqual(graph[1].incoming, [{ lane: 0, color: 0 }])
  assert.deepEqual(graph[2].outgoing, [])
})

test('a merge forks a lane for the second parent and joins it back at the fork point', () => {
  // m merges f (side) into b; both come from a.
  const graph = computeGraph([row('m', 'b', 'f'), row('f', 'a'), row('b', 'a'), row('a')])
  assert.deepEqual(graph[0].outgoing.map((s) => s.lane), [0, 1])
  assert.equal(graph[1].lane, 1)
  assert.deepEqual(graph[1].through.map((s) => s.lane), [0])
  assert.equal(graph[2].lane, 0)
  assert.deepEqual(graph[2].through.map((s) => s.lane), [1])
  assert.equal(graph[3].lane, 0)
  assert.deepEqual(graph[3].incoming.map((s) => s.lane).sort(), [0, 1])
  assert.notEqual(graph[1].color, graph[0].color)
})

test('two branch tips get their own lanes, and freed lanes are reused', () => {
  const graph = computeGraph([row('x', 'a'), row('y', 'a'), row('a', 'r'), row('z', 'r'), row('r')])
  assert.deepEqual(graph.map((g) => g.lane), [0, 1, 0, 1, 0])
  assert.ok(graphSvg(graph[0]).includes('class="node c0"'), 'every commit point is a solid dot')
})

test('uncommitted changes draw a dashed node and a dashed line down to HEAD, across other lanes', () => {
  // HEAD is h; another branch tip t sits between the uncommitted row and HEAD.
  const graph = computeGraph([{ hash: '*', parents: ['h'], dashed: true }, row('t', 'r'), row('h', 'r'), row('r')])
  assert.equal(graph[0].dashed, true)
  assert.deepEqual(graph[0].outgoing, [{ lane: 0, color: 0, dashed: true }])
  assert.deepEqual(graph[1].through, [{ lane: 0, color: 0, dashed: true }])
  assert.deepEqual(graph[2].incoming, [{ lane: 0, color: 0, dashed: true }])
  assert.deepEqual(graph[2].outgoing, [{ lane: 0, color: 0 }], 'below HEAD the lane is solid again')
  assert.equal(graph[2].dashed, undefined)
  const svg = graphSvg(graph[0])
  assert.ok(svg.includes('class="uncommitted c0"'))
  assert.ok(svg.includes('class="edge dashed c0"'))
  assert.ok(!graphSvg(graph[3]).includes('dashed'))
})

test('lane changes are drawn as curves and straight lanes as lines', () => {
  const graph = computeGraph([row('m', 'b', 'f'), row('f', 'a'), row('b', 'a'), row('a')])
  const merge = graphSvg(graph[0])
  assert.ok(merge.includes('M8 12L8 24'), 'first parent continues straight down')
  assert.ok(merge.includes('M8 12C8 22.2 24 13.8 24 24'), 'second parent curves to the next lane')
  assert.ok(!graphSvg(graph[1]).includes('C'), 'a row with no lane change has no curve')
})

test('every row is drawn as wide as the widest row, up to the clip limit', () => {
  const graph = computeGraph([row('m', 'b', 'f'), row('f', 'a'), row('b', 'a'), row('a')])
  assert.equal(graphLanes(graph), 2)
  assert.equal(graphLanes(graph, 1), 1)
  assert.equal(graphLanes([]), 1)
  assert.ok(graphSvg(graph[3], { lanes: 2 }).includes(`width="${2 * LANE_WIDTH}"`))
})

test('colors cycle through the twelve-color palette', () => {
  const tips = Array.from({ length: 13 }, (_, i) => row(`t${i}`, 'root'))
  const graph = computeGraph([...tips, row('root')])
  assert.deepEqual(graph.slice(0, 13).map((g) => g.color), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0])
})

test('relative dates', () => {
  const now = new Date(2026, 0, 15, 15, 0).getTime()
  const at = (d: Date) => d.getTime() / 1000
  assert.equal(relativeDate(at(new Date(2026, 0, 15, 14, 59, 40)), now), 'Moments ago')
  assert.equal(relativeDate(at(new Date(2026, 0, 15, 14, 55)), now), '5 minutes ago')
  assert.equal(relativeDate(at(new Date(2026, 0, 15, 13, 30)), now), '1 hour ago')
  assert.equal(relativeDate(at(new Date(2026, 0, 15, 9, 5)), now), 'Today 09:05')
  assert.equal(relativeDate(at(new Date(2026, 0, 14, 22, 1)), now), 'Yesterday 22:01')
})

test('ref labels merge a branch with its remote counterparts', () => {
  const labels = refLabels(['refs/heads/main', 'refs/remotes/origin/main', 'refs/remotes/origin/dev', 'refs/tags/v1', 'refs/heads/a'], 'main')
  assert.deepEqual(
    labels.map((l) => [l.kind, l.text, !!l.current]),
    [['local', 'origin & main', true], ['local', 'a', false], ['remote', 'origin/dev', false], ['tag', 'v1', false]]
  )
  assert.deepEqual(
    labels.map((l) => [l.name, l.remotes]),
    [['main', ['origin']], ['a', []], ['origin/dev', []], ['v1', []]]
  )
})

test('reachability follows parents from HEAD', () => {
  const rows = [row('x', 'a'), row('y', 'a'), row('a')].map((r) => ({ ...r, author: '', email: '', authorTime: 0, committer: '', commitTime: 0, subject: '', refs: [] }))
  assert.deepEqual([...reachableFrom('y', rows)].sort(), ['a', 'y'])
})

test('side-by-side rows pair deletions with additions and highlight the changed middle', () => {
  const lines = [
    { kind: ' ' as const, text: 'a', old: 1, new: 1 },
    { kind: '-' as const, text: 'let x = 1', old: 2 },
    { kind: '-' as const, text: 'gone', old: 3 },
    { kind: '+' as const, text: 'let x = 42', new: 2 }
  ]
  const rows = splitRows({ oldStart: 1, newStart: 1, section: '', lines })
  assert.deepEqual(rows, [{ left: lines[0], right: lines[0] }, { left: lines[1], right: lines[3] }, { left: lines[2], right: undefined }])
  assert.deepEqual(changedRange('let x = 1', 'let x = 42'), [8, 9, 10])
  assert.equal(changedRange('abc', 'xyz'), null)
  const none = { add: false, del: false }
  const added = { add: true, del: false }
  const removed = { add: false, del: true }
  assert.deepEqual(changeBlocks([none, removed, added, none, added, none, { add: true, del: true }]), [
    { start: 1, end: 3, add: true, del: true },
    { start: 4, end: 5, add: true, del: false },
    { start: 6, end: 7, add: true, del: true }
  ])
  assert.deepEqual(changeBlocks([none, none]), [])
})

test('ruler marks sit where their rows are in the whole diff', () => {
  const row = (offsetTop: number, offsetHeight: number) => ({ offsetTop, offsetHeight }) as HTMLElement
  assert.deepEqual(markSpan(row(100, 20), row(160, 20), 1000), { top: 0.1, height: 0.08 })
  assert.deepEqual(markSpan(row(0, 20), row(0, 20), 0), { top: 0, height: 0 })
})

test('changed files group into folders, joining single-child folder chains', () => {
  const tree = buildFileTree(['app/core/src/main/java/A.java', 'app/core/src/main/resources/META-INF/x', 'app/core/src/test/java/ATest.java', 'README.md'])
  const names = (d: typeof tree): unknown => [d.name, d.count, d.dirs.map(names), d.files]
  assert.deepEqual(names(tree), ['', 4, [['app/core/src', 3, [['main', 2, [['java', 1, [], [0]], ['resources/META-INF', 1, [], [1]]], []], ['test/java', 1, [], [2]]], []]], [3]])
})
