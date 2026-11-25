// The overview ruler beside a diff: one mark per block of changes, placed where it sits in the
// whole diff, and a shade for the part on screen. Clicking a mark goes to its change; clicking or
// dragging elsewhere scrolls there.
import { h } from './dom.ts'

export type RulerMarkKind = 'added' | 'removed' | 'changed'

export interface RulerMark {
  /** First and last rows of the block, inside the scroller. */
  first: HTMLElement
  last: HTMLElement
  kind: RulerMarkKind
}

export interface Ruler {
  element: HTMLElement
  setMarks(marks: RulerMark[]): void
  dispose(): void
}

const TITLES: Record<RulerMarkKind, string> = {
  added: 'Added lines: click to go there',
  removed: 'Removed lines: click to go there',
  changed: 'Changed lines: click to go there'
}

/** A mark's place as fractions of the scroller's content; rows must be laid out (attached). */
export function markSpan(first: HTMLElement, last: HTMLElement, contentHeight: number): { top: number; height: number } {
  if (contentHeight <= 0) return { top: 0, height: 0 }
  const top = first.offsetTop
  const bottom = last.offsetTop + last.offsetHeight
  return { top: top / contentHeight, height: Math.max(0, bottom - top) / contentHeight }
}

const percent = (fraction: number) => `${(Math.min(1, Math.max(0, fraction)) * 100).toFixed(3)}%`

/** `scroller` must be positioned (rows' offsetTop are measured from it); `reveal` scrolls to a row. */
export function createRuler(scroller: HTMLElement, reveal: (row: HTMLElement) => void): Ruler {
  const view = h('div', { class: 'diff-ruler-view' })
  const marksLayer = h('div', { class: 'diff-ruler-marks' })
  const element = h('div', { class: 'diff-ruler', title: 'Changes in this file' }, view, marksLayer)
  let marks: RulerMark[] = []
  let frame = 0

  function updateView(): void {
    const total = scroller.scrollHeight
    const fits = total <= scroller.clientHeight + 1
    view.hidden = fits
    if (fits) return
    view.style.top = percent(scroller.scrollTop / total)
    view.style.height = percent(scroller.clientHeight / total)
  }

  function layout(): void {
    frame = 0
    const total = scroller.scrollHeight
    marksLayer.replaceChildren(
      ...marks.map((mark) => {
        const span = markSpan(mark.first, mark.last, total)
        return h('div', {
          class: `diff-ruler-mark ${mark.kind}`,
          title: TITLES[mark.kind],
          style: `top:${percent(span.top)};height:${percent(span.height)}`,
          onmousedown: (event: MouseEvent) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.stopPropagation()
            reveal(mark.first)
          }
        })
      })
    )
    updateView()
  }

  const scheduleLayout = () => {
    if (!frame) frame = requestAnimationFrame(layout)
  }

  /** Scrolls so the content at `clientY` on the ruler sits in the middle of the view. */
  function scrollToPointer(clientY: number): void {
    const rect = element.getBoundingClientRect()
    if (rect.height <= 0) return
    const fraction = (clientY - rect.top) / rect.height
    scroller.scrollTop = fraction * scroller.scrollHeight - scroller.clientHeight / 2
  }

  element.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    scrollToPointer(event.clientY)
    const move = (e: MouseEvent) => scrollToPointer(e.clientY)
    const up = () => {
      removeEventListener('mousemove', move)
      removeEventListener('mouseup', up)
    }
    addEventListener('mousemove', move)
    addEventListener('mouseup', up)
  })

  scroller.addEventListener('scroll', updateView, { passive: true })
  // Lines wrap, so the marks move whenever the width (or the content) changes.
  const resize = new ResizeObserver(scheduleLayout)
  resize.observe(scroller)

  return {
    element,
    setMarks(next) {
      marks = next
      scheduleLayout()
    },
    dispose() {
      if (frame) cancelAnimationFrame(frame)
      resize.disconnect()
      scroller.removeEventListener('scroll', updateView)
    }
  }
}
