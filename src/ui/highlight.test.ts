import assert from 'node:assert/strict'
import { test } from 'node:test'
import { highlightHunks, segments, tokenizeLine } from './highlight.ts'
import { languageFor } from './languages.ts'

const kinds = (text: string, path: string) => {
  const lang = languageFor(path)
  assert.ok(lang, `a language for ${path}`)
  return tokenizeLine(text, lang).tokens.map((t) => [text.slice(t.start, t.end), t.kind])
}

test('TypeScript: keywords, types, strings, calls, properties, constants and comments', () => {
  assert.deepEqual(kinds('export const actions = party === "FASKES" ? FASKES_ACTIONS : getAction(x.status); // pick', 'a.ts'), [
    ['export', 'keyword'],
    ['const', 'keyword'],
    ['actions', 'variable'],
    ['party', 'variable'],
    ['"FASKES"', 'string'],
    ['FASKES_ACTIONS', 'constant'],
    ['getAction', 'function'],
    ['x', 'variable'],
    ['status', 'property'],
    ['// pick', 'comment']
  ])
  assert.deepEqual(kinds('title: string | null = 42', 'a.tsx'), [
    ['title', 'variable'],
    ['string', 'type'],
    ['null', 'literal'],
    ['42', 'number']
  ])
  assert.deepEqual(kinds("const m = new Map<string, Item>()", 'a.ts').slice(2), [
    ['new', 'keyword'],
    ['Map', 'type'],
    ['string', 'type'],
    ['Item', 'type']
  ])
})

test('an escaped quote does not end a string, and an unknown file stays plain', () => {
  assert.deepEqual(kinds(String.raw`x = 'it\'s' + y`, 'a.js'), [
    ['x', 'variable'],
    [String.raw`'it\'s'`, 'string'],
    ['y', 'variable']
  ])
  assert.equal(languageFor('notes.unknownext'), null)
  assert.equal(languageFor('README'), null)
})

test('JSON keys, YAML keys and comments, CSS properties and markup tags', () => {
  assert.deepEqual(kinds('"name": "orca", "ok": true', 'package.json'), [
    ['"name"', 'property'],
    ['"orca"', 'string'],
    ['"ok"', 'property'],
    ['true', 'literal']
  ])
  assert.deepEqual(kinds('runs-on: ubuntu-latest # where', 'ci.yml'), [
    ['runs-on', 'property'],
    ['# where', 'comment']
  ])
  assert.deepEqual(kinds('  margin-left: 4px;', 'a.css'), [
    ['margin-left', 'property'],
    ['4px', 'number']
  ])
  assert.deepEqual(kinds('<div class="row">x</div>', 'a.html'), [
    ['div', 'tag'],
    ['class', 'property'],
    ['"row"', 'string'],
    ['div', 'tag']
  ])
})

test('a block comment or template string runs on across lines, each diff side on its own', () => {
  const lang = languageFor('a.ts')!
  const first = tokenizeLine('a = 1 /* starts', lang)
  assert.deepEqual(first.open, { close: '*/', kind: 'comment' })
  const second = tokenizeLine('still */ b', lang, first.open)
  assert.deepEqual(second.tokens.map((t) => t.kind), ['comment', 'variable'])
  assert.equal(second.open, null)
  const line = (kind: ' ' | '+' | '-', text: string) => ({ kind, text })
  const removed = line('-', '/* old comment')
  const added = line('+', 'code()')
  const tokens = highlightHunks([{ oldStart: 1, newStart: 1, section: '', lines: [removed, added] }], 'a.ts')
  assert.deepEqual(tokens.get(added)?.map((t) => t.kind), ['function'], 'the removed side comment does not leak into added lines')
  assert.equal(highlightHunks([{ oldStart: 1, newStart: 1, section: '', lines: [added] }], 'a.txt').size, 0)
})

test('segments cut tokens at the changed words', () => {
  const text = 'let total = 42'
  const { tokens } = tokenizeLine(text, languageFor('a.js')!)
  const parts = segments(text, tokens, [4, 9])
  assert.deepEqual(parts.map((s) => [s.text, s.kind ?? '', s.word]), [
    ['let', 'keyword', false],
    [' ', '', false],
    ['total', 'variable', true],
    [' = ', '', false],
    ['42', 'number', false]
  ])
  assert.equal(parts.map((s) => s.text).join(''), text)
  assert.deepEqual(segments('', []), [])
})
