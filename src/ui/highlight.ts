// A small syntax highlighter for the diff viewer: one pass per line, no dependencies. It colors
// comments, strings, numbers, keywords, types, function calls and properties; anything it does not
// recognise stays plain text.
import type { DiffHunk, DiffLine } from '../shared/protocol.ts'
import { languageFor, type Language } from './languages.ts'

export type TokenKind = 'comment' | 'string' | 'number' | 'keyword' | 'literal' | 'type' | 'function' | 'property' | 'variable' | 'constant' | 'tag'

export interface Token {
  start: number
  end: number
  kind: TokenKind
}

/** A comment or string still open at the end of a line, and the text that closes it. */
export interface OpenSpan {
  close: string
  kind: 'comment' | 'string'
}

/** Longer lines stay plain: highlighting them costs more than it helps. */
const MAX_LINE_LENGTH = 2000
const NUMBER = /(?:0[xob][\da-f_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)[a-z%]*/iy
const NAME = /[A-Za-z_$@][\w$]*/y
const DASHED_NAME = /[A-Za-z_$@][\w$-]*/y
const TAG_NAME = /<\/?([A-Za-z][\w:.-]*)/y
const ALL_CAPS = /^[A-Z][A-Z0-9_]+$/

const isWordChar = (ch: string | undefined) => ch !== undefined && /[\w$]/.test(ch)

function nextChar(text: string, from: number): string | undefined {
  for (let i = from; i < text.length; i++) if (text[i] !== ' ' && text[i] !== '\t') return text[i]
  return undefined
}

function previousChar(text: string, before: number): string | undefined {
  for (let i = before - 1; i >= 0; i--) if (text[i] !== ' ' && text[i] !== '\t') return text[i]
  return undefined
}

/** Where `close` ends after `from`, skipping backslash escapes when asked; -1 when it is not on this line. */
function closingIndex(text: string, from: number, close: string, escapes: boolean): number {
  for (let i = from; i < text.length; i++) {
    if (escapes && text[i] === '\\') {
      i++
      continue
    }
    if (text.startsWith(close, i)) return i + close.length
  }
  return -1
}

function classify(name: string, text: string, start: number, end: number, lang: Language, inTag: boolean): TokenKind | null {
  if (lang.markup) return inTag ? 'property' : null
  const key = lang.caseInsensitive ? name.toLowerCase() : name
  if (lang.keywords.has(key)) return 'keyword'
  if (lang.constants.has(key)) return 'literal'
  if (lang.types.has(key)) return 'type'
  const next = nextChar(text, end)
  if (next === '(') return 'function'
  if (lang.keysBeforeColon && next === ':') return 'property'
  if (previousChar(text, start) === '.') return 'property'
  if (ALL_CAPS.test(name)) return 'constant'
  if (lang.capitalizedTypes && /^[A-Z]/.test(name)) return 'type'
  return lang.keywords.size ? 'variable' : null
}

/** Tokens of one line, given what the previous line left open; returns what this one leaves open. */
export function tokenizeLine(text: string, lang: Language, open: OpenSpan | null = null): { tokens: Token[]; open: OpenSpan | null } {
  const tokens: Token[] = []
  if (text.length > MAX_LINE_LENGTH) return { tokens, open: null }
  const push = (start: number, end: number, kind: TokenKind) => end > start && tokens.push({ start, end, kind })
  /** Pushes a span that may run past the line; returns where scanning resumes, or -1 if it stays open. */
  const span = (start: number, from: number, close: string, kind: OpenSpan['kind']) => {
    const end = closingIndex(text, from, close, kind === 'string')
    push(start, end < 0 ? text.length : end, kind)
    return end
  }
  let i = 0
  if (open) {
    i = span(0, 0, open.close, open.kind)
    if (i < 0) return { tokens, open }
  }
  let inTag = false
  while (i < text.length) {
    const ch = text[i]
    if (ch === ' ' || ch === '\t') {
      i++
      continue
    }
    const lineComment = lang.lineComments.find((c) => text.startsWith(c, i) && (c !== '#' || i === 0 || /\s/.test(text[i - 1])))
    if (lineComment) {
      push(i, text.length, 'comment')
      break
    }
    const block = lang.blockComment
    if (block && text.startsWith(block[0], i)) {
      const end = span(i, i + block[0].length, block[1], 'comment')
      if (end < 0) return { tokens, open: { close: block[1], kind: 'comment' } }
      i = end
      continue
    }
    const multiline = lang.multilineStrings.find((q) => text.startsWith(q, i))
    if (multiline) {
      const end = span(i, i + multiline.length, multiline, 'string')
      if (end < 0) return { tokens, open: { close: multiline, kind: 'string' } }
      i = end
      continue
    }
    if (lang.quotes.includes(ch)) {
      const found = closingIndex(text, i + 1, ch, true)
      const end = found < 0 ? text.length : found
      push(i, end, lang.keysBeforeColon && nextChar(text, end) === ':' ? 'property' : 'string')
      i = end
      continue
    }
    if (lang.markup && ch === '<') {
      TAG_NAME.lastIndex = i
      const tag = TAG_NAME.exec(text)
      if (tag) {
        push(tag.index + tag[0].length - tag[1].length, tag.index + tag[0].length, 'tag')
        inTag = true
        i = TAG_NAME.lastIndex
        continue
      }
    }
    if (lang.markup && ch === '>') inTag = false
    if (/\d/.test(ch) && !isWordChar(text[i - 1])) {
      NUMBER.lastIndex = i
      if (NUMBER.exec(text)) {
        push(i, NUMBER.lastIndex, 'number')
        i = NUMBER.lastIndex
        continue
      }
    }
    const name = lang.dashedNames ? DASHED_NAME : NAME
    name.lastIndex = i
    const word = name.exec(text)
    if (word) {
      const end = i + word[0].length
      const kind = classify(word[0], text, i, end, lang, inTag)
      if (kind) push(i, end, kind)
      i = end
      continue
    }
    i++
  }
  return { tokens, open: null }
}

/**
 * Tokens of every line of a file's hunks. Each side keeps its own open comment or string, so a
 * comment opened in removed lines does not color the added ones; each hunk starts fresh.
 */
export function highlightHunks(hunks: DiffHunk[], path: string): Map<DiffLine, Token[]> {
  const result = new Map<DiffLine, Token[]>()
  const lang = languageFor(path)
  if (!lang) return result
  for (const hunk of hunks) {
    let oldOpen: OpenSpan | null = null
    let newOpen: OpenSpan | null = null
    for (const line of hunk.lines) {
      const { tokens, open } = tokenizeLine(line.text, lang, line.kind === '-' ? oldOpen : newOpen)
      if (line.kind !== '+') oldOpen = open
      if (line.kind !== '-') newOpen = open
      if (tokens.length) result.set(line, tokens)
    }
  }
  return result
}

export interface Segment {
  text: string
  kind?: TokenKind
  /** Inside the changed words of a paired line. */
  word: boolean
}

/** Splits a line into runs of one token kind, also cut where the changed words begin and end. */
export function segments(text: string, tokens: Token[], range?: [number, number]): Segment[] {
  const cuts = new Set([0, text.length])
  for (const t of tokens) cuts.add(t.start).add(t.end)
  if (range) cuts.add(range[0]).add(range[1])
  const points = [...cuts].filter((p) => p >= 0 && p <= text.length).sort((a, b) => a - b)
  const result: Segment[] = []
  let t = 0
  for (let p = 0; p < points.length - 1; p++) {
    const [start, end] = [points[p], points[p + 1]]
    while (t < tokens.length && tokens[t].end <= start) t++
    const token = tokens[t] && tokens[t].start <= start ? tokens[t] : undefined
    const segment: Segment = { text: text.slice(start, end), word: Boolean(range && start >= range[0] && end <= range[1]) }
    result.push(token ? { ...segment, kind: token.kind } : segment)
  }
  return result
}
