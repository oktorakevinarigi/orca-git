import type { DiffHunk, DiffLine } from '../shared/protocol.ts'

export interface SplitRow {
  left?: DiffLine
  right?: DiffLine
}

/** Side-by-side rows: context on both sides, each run of deletions paired with the additions after it. */
export function splitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = []
  const lines = hunk.lines
  for (let i = 0; i < lines.length; ) {
    if (lines[i].kind === ' ') {
      rows.push({ left: lines[i], right: lines[i] })
      i++
      continue
    }
    const removed: DiffLine[] = []
    const added: DiffLine[] = []
    while (i < lines.length && lines[i].kind === '-') removed.push(lines[i++])
    while (i < lines.length && lines[i].kind === '+') added.push(lines[i++])
    for (let k = 0; k < Math.max(removed.length, added.length); k++) rows.push({ left: removed[k], right: added[k] })
  }
  return rows
}

/** The changed middle of two versions of a line, as [start, oldEnd, newEnd]; null when nothing is shared. */
export function changedRange(before: string, after: string): [number, number, number] | null {
  const max = Math.min(before.length, after.length)
  let start = 0
  while (start < max && before[start] === after[start]) start++
  let end = 0
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++
  if (start === 0 && end === 0) return null
  return [start, before.length - end, after.length - end]
}

/** What one shown row changes: lines added, lines removed, both (side by side) or neither. */
export interface RowChange {
  add: boolean
  del: boolean
}

/** A run of changed rows, `end` excluded; for change navigation and the overview ruler. */
export interface ChangeBlock extends RowChange {
  start: number
  end: number
}

export function changeBlocks(rows: RowChange[]): ChangeBlock[] {
  const blocks: ChangeBlock[] = []
  let current: ChangeBlock | null = null
  rows.forEach((row, i) => {
    if (!row.add && !row.del) {
      current = null
      return
    }
    if (!current) {
      current = { start: i, end: i + 1, add: row.add, del: row.del }
      blocks.push(current)
      return
    }
    // The block is built here and nowhere else, so extending it in place is safe.
    current.end = i + 1
    current.add ||= row.add
    current.del ||= row.del
  })
  return blocks
}
