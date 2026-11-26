// Commit graph lanes: a branch keeps its lane and color; merges and forks draw
// rounded curves between the node and neighbouring lanes. Lanes never shift sideways, so a line
// passing through a row is one vertical segment.

export interface GraphInput {
  hash: string
  parents: string[]
  /** The uncommitted changes row: its node and its line down to HEAD are dashed. */
  dashed?: boolean
}

export interface Segment {
  lane: number
  color: number
  dashed?: boolean
}

export interface GraphRow {
  lane: number
  color: number
  /** Lanes passing straight through the row. */
  through: Segment[]
  /** Lanes ending at the node, from the top edge (the node's children). */
  incoming: Segment[]
  /** Lanes leaving the node towards the bottom edge (its parents). */
  outgoing: Segment[]
  /** Number of lanes used by this row. */
  width: number
  /** The uncommitted changes row. */
  dashed?: boolean
}

export const COLORS = 12

export function computeGraph(rows: GraphInput[], linear = false): GraphRow[] {
  if (linear) {
    return rows.map((_, i) => ({
      lane: 0,
      color: 0,
      through: [],
      incoming: i > 0 ? [{ lane: 0, color: 0 }] : [],
      outgoing: i < rows.length - 1 ? [{ lane: 0, color: 0 }] : [],
      width: 1
    }))
  }
  const lanes: (string | null)[] = []
  const colors: number[] = []
  /** Lanes drawn dashed: they come from the uncommitted changes row. */
  const dashedLanes: boolean[] = []
  let nextColor = 0
  const segment = (lane: number, dashed = dashedLanes[lane]): Segment =>
    dashed ? { lane, color: colors[lane], dashed: true } : { lane, color: colors[lane] }
  const free = (avoid = -1) => {
    const index = lanes.findIndex((lane, i) => lane === null && i !== avoid)
    return index < 0 ? Math.max(lanes.length, avoid + 1) : index
  }
  const out: GraphRow[] = []
  for (const row of rows) {
    const incomingLanes: number[] = []
    lanes.forEach((hash, i) => hash === row.hash && incomingLanes.push(i))
    let lane = incomingLanes.length ? incomingLanes[0] : free()
    if (!incomingLanes.length) {
      lanes[lane] = null
      colors[lane] = nextColor++ % COLORS
    }
    const color = colors[lane]
    const incoming = incomingLanes.map((i) => segment(i))
    const through: Segment[] = []
    lanes.forEach((hash, i) => hash !== null && hash !== row.hash && through.push(segment(i)))
    for (const i of incomingLanes) {
      lanes[i] = null
      dashedLanes[i] = false
    }

    const dashed = Boolean(row.dashed)
    const outgoing: Segment[] = []
    row.parents.forEach((parent, index) => {
      // The first parent continues the node's lane even when another lane already waits for it:
      // both lines then converge on the fork commit.
      const existing = index === 0 && lanes[lane] === null ? -1 : lanes.indexOf(parent)
      if (existing >= 0) {
        outgoing.push(segment(existing, dashed))
        return
      }
      const target = index === 0 && lanes[lane] === null ? lane : free(lane)
      lanes[target] = parent
      dashedLanes[target] = dashed
      if (target !== lane) colors[target] = nextColor++ % COLORS
      else colors[target] = color
      outgoing.push(segment(target))
    })
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    const width = Math.max(lane + 1, ...through.map((s) => s.lane + 1), ...incoming.map((s) => s.lane + 1), ...outgoing.map((s) => s.lane + 1))
    out.push(dashed ? { lane, color, through, incoming, outgoing, width, dashed } : { lane, color, through, incoming, outgoing, width })
  }
  return out
}

export const LANE_WIDTH = 16
export const ROW_HEIGHT = 24
/** Lanes shown before the graph column clips, so very wide histories don't push the subjects away. */
export const MAX_GRAPH_LANES = 12
const NODE_RADIUS = 4
/** How far the curve's control points pull along the vertical, as a share of the half-row. */
const CURVE_PULL = 0.85

const x = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2

/** Lanes of the graph column: every row is drawn this wide so the subjects line up. */
export function graphLanes(rows: GraphRow[], max = MAX_GRAPH_LANES): number {
  let lanes = 1
  for (const row of rows) lanes = Math.max(lanes, row.width)
  return Math.min(lanes, max)
}

/** A vertical line, or an S-curve with vertical ends when it changes lane. */
function edge(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M${x1} ${y1}L${x2} ${y2}`
  const pull = (y2 - y1) * CURVE_PULL
  return `M${x1} ${y1}C${x1} ${y1 + pull} ${x2} ${y2 - pull} ${x2} ${y2}`
}

export interface GraphSvgOptions {
  /** Lanes of the graph column (see graphLanes); the row's own width when omitted. */
  lanes?: number
}

/**
 * The lanes leaving `row` drawn straight down over `height` pixels: the graph under a commit
 * while its details are expanded below it.
 */
export function graphGapSvg(row: GraphRow, height: number, options: GraphSvgOptions = {}): string {
  const width = (options.lanes ?? row.width) * LANE_WIDTH
  const lanes = new Map<number, Segment>()
  for (const s of [...row.through, ...row.outgoing]) if (!lanes.has(s.lane)) lanes.set(s.lane, s)
  const parts = [...lanes.values()].map(
    (s) => `<path d="${edge(x(s.lane), 0, x(s.lane), height)}" class="edge${s.dashed ? ' dashed' : ''} c${s.color}"/>`
  )
  return `<svg class="graph" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`
}

/** One row of the graph as SVG markup. */
export function graphSvg(row: GraphRow, options: GraphSvgOptions = {}): string {
  const h = ROW_HEIGHT
  const mid = h / 2
  const width = (options.lanes ?? row.width) * LANE_WIDTH
  const parts: string[] = []
  const path = (d: string, s: Segment) => parts.push(`<path d="${d}" class="edge${s.dashed ? ' dashed' : ''} c${s.color}"/>`)
  for (const s of row.through) path(edge(x(s.lane), 0, x(s.lane), h), s)
  for (const s of row.incoming) path(edge(x(s.lane), 0, x(row.lane), mid), s)
  for (const s of row.outgoing) path(edge(x(row.lane), mid, x(s.lane), h), s)
  parts.push(`<circle cx="${x(row.lane)}" cy="${mid}" r="${NODE_RADIUS}" class="${row.dashed ? 'uncommitted' : 'node'} c${row.color}"/>`)
  return `<svg class="graph" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">${parts.join('')}</svg>`
}
