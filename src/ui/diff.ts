import type { DiffHunk, DiffLine, FileChange, FileDiff } from '../shared/protocol.ts'
import { api, errorMessage } from './api.ts'
import { h, icon } from './dom.ts'
import { changeBlocks, changedRange, splitRows, type RowChange } from './diffmodel.ts'
import { revisionLabel, shortHash, STATUS_NAMES, WORKTREE } from './format.ts'
import { highlightHunks, segments, type Segment, type Token } from './highlight.ts'
import { closePopups } from './menu.ts'
import { createRuler, type RulerMark } from './ruler.ts'

export type DiffMode = 'split' | 'unified'

export interface DiffOptions {
  root: string
  hash: string
  files: FileChange[]
  index: number
  mode?: DiffMode
  /** Show the whole file (the default) rather than only the changed regions. */
  wholeFile?: boolean
  /** Called when the user switches layout or context, to remember it. */
  onPrefs?(mode: DiffMode, wholeFile: boolean): void
  /** Fills the page of its own editor tab: no close button, Escape does nothing. */
  embedded?: boolean
  /** Workspace to open work-tree files in; the worker picks the one holding `root` otherwise. */
  workspaceId?: string | null
}

let closeOpen: (() => void) | null = null
/** Space left above a change scrolled into view, so the line before it shows. */
const REVEAL_MARGIN = 40

/** Highlight ranges for lines paired with a counterpart: only the changed middle is emphasised. */
function wordRanges(hunks: DiffHunk[]): Map<DiffLine, [number, number]> {
  const ranges = new Map<DiffLine, [number, number]>()
  for (const hunk of hunks) {
    for (const { left, right } of splitRows(hunk)) {
      if (left?.kind !== '-' || right?.kind !== '+' || left.text.length > 2000 || right.text.length > 2000) continue
      const range = changedRange(left.text, right.text)
      if (!range) continue
      ranges.set(left, [range[0], range[1]])
      ranges.set(right, [range[0], range[2]])
    }
  }
  return ranges
}

interface LineStyles {
  ranges: Map<DiffLine, [number, number]>
  tokens: Map<DiffLine, Token[]>
}

const segmentNode = (s: Segment): Node => (s.kind ? h('span', { class: `tk-${s.kind}` }, s.text) : document.createTextNode(s.text))

/** A line's code, syntax-colored, with its changed words (if paired with a counterpart) emphasised. */
function code(line: DiffLine | undefined, styles: LineStyles): HTMLElement {
  if (!line) return h('div', { class: 'd-code d-empty' })
  const cls = `d-code ${line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : ''}`
  if (!line.text) return h('div', { class: cls }, '\u200b')
  const range = styles.ranges.get(line)
  const word = range && range[0] !== range[1] ? range : undefined
  const parts = segments(line.text, styles.tokens.get(line) ?? [], word)
  const changed = parts.filter((s) => s.word)
  if (!changed.length) return h('div', { class: cls }, ...parts.map(segmentNode))
  const first = parts.indexOf(changed[0])
  return h(
    'div',
    { class: cls },
    ...parts.slice(0, first).map(segmentNode),
    h('span', { class: 'word' }, ...changed.map(segmentNode)),
    ...parts.slice(first + changed.length).map(segmentNode)
  )
}

const num = (value: number | undefined, kind?: string) =>
  h('div', { class: `d-num ${kind === '+' ? 'add' : kind === '-' ? 'del' : ''}` }, value === undefined ? '' : String(value))

const hunkRow = (hunk: DiffHunk) =>
  h('div', { class: 'd-hunk' }, `@@ -${hunk.oldStart} +${hunk.newStart} @@`, hunk.section ? h('span', { class: 'section' }, hunk.section) : null)

function renderLines(diff: FileDiff, mode: DiffMode): { rows: HTMLElement[]; marks: RulerMark[] } {
  const styles: LineStyles = { ranges: wordRanges(diff.hunks), tokens: highlightHunks(diff.hunks, diff.path) }
  const rows: HTMLElement[] = []
  const changes: RowChange[] = []
  const unchanged: RowChange = { add: false, del: false }
  for (const hunk of diff.hunks) {
    if (diff.hunks.length > 1 || hunk.oldStart > 1 || hunk.newStart > 1) {
      rows.push(hunkRow(hunk))
      changes.push(unchanged)
    }
    if (mode === 'split') {
      for (const { left, right } of splitRows(hunk)) {
        const change = { add: right?.kind === '+', del: left?.kind === '-' }
        // Both line numbers sit in a gutter between the two sides.
        rows.push(
          h(
            'div',
            { class: `d-row${change.add || change.del ? ' change' : ''}` },
            code(left, styles),
            num(left?.old, left?.kind),
            num(right?.new, right?.kind),
            code(right, styles)
          )
        )
        changes.push(change)
      }
    } else {
      for (const line of hunk.lines) {
        rows.push(h('div', { class: `d-row${line.kind === ' ' ? '' : ' change'}` }, num(line.old, line.kind), num(line.new, line.kind), code(line, styles)))
        changes.push({ add: line.kind === '+', del: line.kind === '-' })
      }
    }
  }
  const marks = changeBlocks(changes).map((block) => ({
    first: rows[block.start],
    last: rows[block.end - 1],
    kind: block.add && block.del ? ('changed' as const) : block.add ? ('added' as const) : ('removed' as const)
  }))
  return { rows, marks }
}

/** Opens the full-window viewer on `files[index]`; Escape closes it, Alt+↑/↓ moves between files. */
export function openDiff(options: DiffOptions): void {
  closeOpen?.()
  closePopups()
  const { root, hash, files } = options
  let index = Math.max(0, Math.min(options.index, files.length - 1))
  let mode: DiffMode = options.mode ?? (innerWidth < 700 ? 'unified' : 'split')
  let wholeFile = options.wholeFile ?? true
  let diff: FileDiff | null = null
  let changes: HTMLElement[] = []
  let token = 0

  const body = h('div', { class: 'diff-body', tabindex: '-1' })
  const ruler = createRuler(body, reveal)
  const button =(iconName: Parameters<typeof icon>[0], tip: string, run: () => void) =>
    h('button', { class: 'tool', title: tip, 'aria-label': tip, onclick: run }, icon(iconName))
  const sep = () => h('span', { class: 'sep' })
  const prevChange = button('up', 'Previous change (Shift+F7)', () => jump(-1))
  const nextChange = button('down', 'Next change (F7)', () => jump(1))
  const prevFile = button('left', 'Previous file (Alt+↑)', () => go(index - 1))
  const nextFile = button('right', 'Next file (Alt+↓)', () => go(index + 1))
  const counter = h('span', { class: 'diff-counter' })
  const wholeButton = button('unfold', '', () => setWhole(!wholeFile))
  const differences = h('span', { class: 'diff-count' })
  const splitButton = button('split', 'Side-by-side', () => setMode('split'))
  const unifiedButton = button('unified', 'Unified', () => setMode('unified'))
  const worktree = hash === WORKTREE
  const openButton = button('external', 'Open file in the editor', () => void openFile())
  const fileBar = h('div', { class: 'diff-files' })
  const view = h(
    'div',
    { class: 'diff-view', role: 'dialog', 'aria-modal': 'true' },
    h(
      'div',
      { class: 'diff-header' },
      prevChange,
      nextChange,
      sep(),
      prevFile,
      counter,
      nextFile,
      sep(),
      wholeButton,
      openButton,
      h('div', { class: 'spacer' }),
      differences,
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Layout' }, splitButton, unifiedButton),
      options.embedded ? null : sep(),
      options.embedded ? null : button('close', 'Close (Esc)', () => close())
    ),
    fileBar,
    h('div', { class: 'diff-main' }, body, ruler.element)
  )

  /** One side of the file bar: the revision it shows (read-only) and its path. */
  const side = (revision: string, path: string | null, letter?: string) =>
    h(
      'div',
      { class: 'diff-side' },
      letter ? h('span', { class: `status-letter st-${letter}`, title: STATUS_NAMES[letter] ?? letter }, letter) : null,
      icon('lock'),
      h('span', { class: 'rev mono' }, revision),
      path ? h('span', { class: 'path', title: path }, path) : null
    )

  function syncHeader(): void {
    const file = files[index]
    const letter = file.status[0] ?? 'M'
    const oldPath = file.oldPath ?? file.path
    const oldRevision = file.base ? shortHash(file.base) : worktree ? 'HEAD' : `${shortHash(hash)}^`
    const newRevision = revisionLabel(file.tip ?? hash)
    openButton.hidden = !worktree || letter === 'D'
    fileBar.className = `diff-files ${mode}`
    fileBar.replaceChildren(
      ...(mode === 'split'
        ? [side(oldRevision, oldPath, letter), side(newRevision, oldPath !== file.path ? file.path : null)]
        : [side(`${oldRevision} → ${newRevision}`, oldPath !== file.path ? `${oldPath} → ${file.path}` : file.path, letter)])
    )
    counter.textContent = files.length === 1 ? '1 file' : `${index + 1} of ${files.length} files`
    const fileName = file.path.slice(file.path.lastIndexOf('/') + 1)
    if (options.embedded) document.title = worktree ? `${fileName} (uncommitted)` : `${fileName} @${shortHash(hash)}`
    prevFile.disabled = index === 0
    nextFile.disabled = index === files.length - 1
    splitButton.classList.toggle('on', mode === 'split')
    unifiedButton.classList.toggle('on', mode === 'unified')
    splitButton.setAttribute('aria-pressed', String(mode === 'split'))
    unifiedButton.setAttribute('aria-pressed', String(mode === 'unified'))
    wholeButton.classList.toggle('on', wholeFile)
    wholeButton.setAttribute('aria-pressed', String(wholeFile))
    const wholeTip = wholeFile ? 'Show only the changed regions' : 'Show the whole file'
    wholeButton.title = wholeTip
    wholeButton.setAttribute('aria-label', wholeTip)
  }

  function syncDifferences(): void {
    const count = changes.length
    differences.textContent = !diff ? '' : diff.binary ? 'Binary file' : count === 0 ? 'No differences' : count === 1 ? '1 difference' : `${count} differences`
    prevChange.disabled = nextChange.disabled = count === 0
  }

  function render(): void {
    renderBody()
    syncDifferences()
  }

  function renderBody(): void {
    changes = []
    ruler.setMarks([])
    if (!diff) return
    const note = (text: string) => h('div', { class: 'diff-note muted' }, text)
    if (diff.binary) {
      body.replaceChildren(note('Binary file: no text changes to show.'))
      return
    }
    if (!diff.hunks.length) {
      body.replaceChildren(note(files[index].oldPath ? 'File renamed without content changes.' : 'No content changes.'))
      return
    }
    const digits = String(Math.max(...diff.hunks.map((x) => Math.max(x.oldStart, x.newStart) + x.lines.length))).length
    const rendered = renderLines(diff, mode)
    changes = rendered.marks.map((mark) => mark.first)
    const lines = h('div', { class: `diff-lines ${mode}`, style: `--num-w: ${digits + 2}ch` }, ...rendered.rows)
    body.replaceChildren(...(diff.truncated ? [note('This diff is too large: only the beginning is shown.')] : []), lines)
    ruler.setMarks(rendered.marks)
  }

  async function load(): Promise<void> {
    const mine = ++token
    syncHeader()
    diff = null
    changes = []
    ruler.setMarks([])
    syncDifferences()
    body.replaceChildren(h('div', { class: 'diff-note muted' }, 'Loading…'))
    try {
      const result = await api.diff(root, hash, files[index], wholeFile)
      if (mine !== token) return
      diff = result
      render()
      body.scrollTop = 0
      if (wholeFile && changes.length) jump(1, -Infinity)
    } catch (error) {
      if (mine === token) body.replaceChildren(h('div', { class: 'diff-note error' }, errorMessage(error)))
    }
  }

  /** Opens the work-tree file in an editor tab; says why in the view when it cannot. */
  async function openFile(): Promise<void> {
    let reason: string | undefined
    try {
      const result = await api.openFile(root, files[index].path, options.workspaceId)
      reason = result.ok ? undefined : result.reason ?? 'The file could not be opened.'
    } catch (error) {
      reason = errorMessage(error)
    }
    if (reason) body.prepend(h('div', { class: 'diff-note error' }, reason))
  }

  function go(next: number): void {
    if (next < 0 || next >= files.length || next === index) return
    index = next
    void load()
  }

  function setMode(next: DiffMode): void {
    mode = next
    options.onPrefs?.(mode, wholeFile)
    syncHeader()
    render()
  }

  function setWhole(next: boolean): void {
    wholeFile = next
    options.onPrefs?.(mode, wholeFile)
    void load()
  }

  /** Scrolls a row to just below the top of the view. */
  function reveal(row: HTMLElement): void {
    body.scrollTop += row.getBoundingClientRect().top - (body.getBoundingClientRect().top + REVEAL_MARGIN)
  }

  /** Scrolls the next or previous block of changes to just below the top of the view. */
  function jump(direction: 1 | -1, from = body.getBoundingClientRect().top + REVEAL_MARGIN): void {
    if (!changes.length) return
    const offsets = changes.map((el) => el.getBoundingClientRect().top - from)
    let i = direction > 0 ? offsets.findIndex((y) => y > 2) : offsets.findLastIndex((y) => y < -2)
    if (i < 0) i = direction > 0 ? 0 : changes.length - 1
    reveal(changes[i])
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !options.embedded) close()
    else if (event.altKey && event.key === 'ArrowUp') go(index - 1)
    else if (event.altKey && event.key === 'ArrowDown') go(index + 1)
    else if (event.key === 'F7') jump(event.shiftKey ? -1 : 1)
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  const previousFocus = document.activeElement as HTMLElement | null
  function close(): void {
    token++
    document.removeEventListener('keydown', onKey, true)
    ruler.dispose()
    view.remove()
    closeOpen = null
    previousFocus?.focus({ preventScroll: true })
  }

  closeOpen = close
  document.addEventListener('keydown', onKey, true)
  document.body.append(view)
  body.focus({ preventScroll: true })
  void load()
}
