// Resizable log columns. Subject takes whatever width is left; dragging the border after a column
// widens it and narrows the column after it, so the other columns stay where they are.
import { h } from './dom.ts'

export interface ColumnWidths {
  author: number
  date: number
  hash: number
}

/** The border to the right of this column. */
export type ColumnBorder = 'subject' | 'author' | 'date'

/** The stylesheet's widths at full size; used for a column hidden by a narrow layout. */
export const DEFAULT_COLUMN_WIDTHS: ColumnWidths = { author: 150, date: 150, hash: 76 }
export const MIN_COLUMN_WIDTH = 48
export const MIN_SUBJECT_WIDTH = 120

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

/** The widths after dragging `border` by `dx` pixels from `start` (`subjectWidth` is Subject's width then). */
export function resizeColumns(start: ColumnWidths, border: ColumnBorder, dx: number, subjectWidth: number): ColumnWidths {
  switch (border) {
    case 'subject': {
      const moved = clamp(dx, MIN_SUBJECT_WIDTH - subjectWidth, start.author - MIN_COLUMN_WIDTH)
      return { ...start, author: Math.round(start.author - moved) }
    }
    case 'author': {
      const moved = clamp(dx, MIN_COLUMN_WIDTH - start.author, start.date - MIN_COLUMN_WIDTH)
      return { ...start, author: Math.round(start.author + moved), date: Math.round(start.date - moved) }
    }
    case 'date': {
      const moved = clamp(dx, MIN_COLUMN_WIDTH - start.date, start.hash - MIN_COLUMN_WIDTH)
      return { ...start, date: Math.round(start.date + moved), hash: Math.round(start.hash - moved) }
    }
  }
}

/** Saved widths, or null when they are missing or not numbers (the stylesheet's defaults apply). */
export function validColumnWidths(value: unknown): ColumnWidths | null {
  const v = value as Partial<ColumnWidths> | null
  const ok = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= MIN_COLUMN_WIDTH
  return v && ok(v.author) && ok(v.date) && ok(v.hash) ? { author: v.author!, date: v.date!, hash: v.hash! } : null
}

export interface ColumnResizeHandlers {
  /** While dragging: the new widths. */
  change(widths: ColumnWidths): void
  /** The drag ended. */
  done(): void
  /** Double-click on a border: back to the default widths. */
  reset(): void
}

/** Adds a drag handle to the right edge of the Subject, Author and Date header cells. */
export function addColumnResizers(header: HTMLElement, handlers: ColumnResizeHandlers): void {
  const cell = (name: string) => header.querySelector<HTMLElement>(`:scope > .${name}`)
  const width = (name: string) => cell(name)?.getBoundingClientRect().width ?? 0
  /** A hidden column measures 0: keep its full-size width so it comes back as it was. */
  const shown = (name: keyof ColumnWidths) => width(name) || DEFAULT_COLUMN_WIDTHS[name]
  for (const border of ['subject', 'author', 'date'] as const) {
    const handle = h('div', { class: 'col-resize', title: 'Drag to resize; double-click to reset', 'aria-hidden': 'true' })
    handle.addEventListener('dblclick', (event) => {
      event.preventDefault()
      handlers.reset()
    })
    handle.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      // Measured from the screen, so the narrow layouts' own defaults are the starting point.
      const start: ColumnWidths = { author: shown('author'), date: shown('date'), hash: shown('hash') }
      const subjectWidth = width('subject')
      document.body.classList.add('col-resizing')
      const move = (e: MouseEvent) => handlers.change(resizeColumns(start, border, e.clientX - event.clientX, subjectWidth))
      const up = () => {
        removeEventListener('mousemove', move)
        removeEventListener('mouseup', up)
        document.body.classList.remove('col-resizing')
        handlers.done()
      }
      addEventListener('mousemove', move)
      addEventListener('mouseup', up)
    })
    cell(border)?.append(handle)
  }
}
