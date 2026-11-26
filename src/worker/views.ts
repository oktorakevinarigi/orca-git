// Views of the log kept in the worker: Orca runs panels in sandboxed frames that have no storage of
// their own and may only send small messages, and it can rebuild a tab's frame when the tab comes
// back. Each frame sends what it shows (selection, scroll, opened commit); the commits, refs and
// details it was answered with are recorded here as they are served, and handed back together.
import type { CommitDetails, CommitRow, FileChange, LogFilter, LogPage, RefsResult, SavedView, ViewState } from '../shared/protocol.ts'

/** Views kept, newest first: a few tabs and the side panel. */
const MAX_VIEWS = 8
/** Repositories whose answers are kept, and filters per repository. */
const MAX_ROOTS = 8
const MAX_FILTERS = 4
const MAX_DETAILS = 100
const MAX_KEY_CHARS = 4096

interface Served {
  rows: CommitRow[]
  hasMore: boolean
}

interface RootAnswers {
  /** Commits served per filter, pages joined in order. */
  pages: Map<string, Served>
  refs: RefsResult | null
  details: Map<string, CommitDetails>
  uncommittedFiles: FileChange[] | null
}

/** One spelling per filter, whatever order its fields were set in. */
export function filterKey(filter: LogFilter | undefined): string {
  const value = (filter ?? {}) as Record<string, unknown>
  return JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]))
}

/** Keeps the newest `max` entries of `map`, `key` counting as the newest. */
function touch<V>(map: Map<string, V>, key: string, value: V, max: number): V {
  map.delete(key)
  map.set(key, value)
  while (map.size > max) map.delete(map.keys().next().value!)
  return value
}

function isViewState(value: unknown): value is ViewState {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<ViewState>
  return (
    typeof state.repo?.root === 'string' &&
    Boolean(state.repo.root) &&
    Array.isArray(state.selected) &&
    state.selected.every((hash) => typeof hash === 'string') &&
    typeof state.rowCount === 'number' &&
    typeof state.scrollTop === 'number' &&
    Boolean(state.filter) &&
    typeof state.filter === 'object'
  )
}

export function createViewStore() {
  const roots = new Map<string, RootAnswers>()
  const views = new Map<string, ViewState>()

  const answersOf = (root: string): RootAnswers =>
    roots.get(root) ?? touch(roots, root, { pages: new Map(), refs: null, details: new Map(), uncommittedFiles: null }, MAX_ROOTS)

  return {
    /** A page of the log served for `filter` from entry `skip`: the first one starts the list again. */
    recordPage(root: string, filter: LogFilter | undefined, skip: number, page: LogPage): void {
      const pages = answersOf(root).pages
      const key = filterKey(filter)
      const known = pages.get(key)
      if (skip === 0 || !known) {
        touch(pages, key, { rows: page.commits, hasMore: page.hasMore }, MAX_FILTERS)
        return
      }
      const seen = new Set(known.rows.map((row) => row.hash))
      touch(pages, key, { rows: known.rows.concat(page.commits.filter((row) => !seen.has(row.hash))), hasMore: page.hasMore }, MAX_FILTERS)
    },
    recordRefs(root: string, refs: RefsResult): void {
      answersOf(root).refs = refs
    },
    recordDetails(root: string, details: CommitDetails): void {
      touch(answersOf(root).details, details.hash, details, MAX_DETAILS)
    },
    recordUncommittedFiles(root: string, files: FileChange[]): void {
      answersOf(root).uncommittedFiles = files
    },
    /** Refs moved: which branches hold a commit may have changed. */
    forgetDetails(root: string): void {
      roots.get(root)?.details.clear()
    },
    forgetUncommitted(root: string): void {
      const answers = roots.get(root)
      if (answers) answers.uncommittedFiles = null
    },
    save(key: unknown, state: unknown): boolean {
      if (typeof key !== 'string' || !key || key.length > MAX_KEY_CHARS || !isViewState(state)) return false
      touch(views, key, state, MAX_VIEWS)
      return true
    },
    /** The view saved under `key` with the answers it showed; null when they are no longer all here. */
    load(key: unknown): SavedView | null {
      if (typeof key !== 'string') return null
      const state = views.get(key)
      if (!state) return null
      const answers = roots.get(state.repo.root)
      const served = answers?.pages.get(filterKey(state.filter))
      if (!answers || !served?.rows.length) return null
      const rows = served.rows.slice(0, Math.max(1, state.rowCount))
      const single = !state.uncommittedSelected && state.selected.length === 1 ? state.selected[0] : null
      return {
        ...state,
        rows,
        hasMore: served.hasMore || rows.length < served.rows.length,
        refs: answers.refs,
        details: single ? (answers.details.get(single) ?? null) : null,
        uncommittedFiles: state.uncommittedSelected ? answers.uncommittedFiles : null
      }
    },
    clear(): void {
      roots.clear()
      views.clear()
    }
  }
}
