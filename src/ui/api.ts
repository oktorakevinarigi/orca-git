// Thin typed wrapper over the frame's `window.orca` (no Node, no network in a frame).
import type {
  ActionRequest,
  ActionResult,
  CheckResult,
  CommitDetails,
  DiffTabRequest,
  FileChange,
  FileDiff,
  FirstPageRequest,
  LogFilter,
  LogPage,
  PatchResult,
  PushPlan,
  RefsResult,
  RepoResult,
  RepoStamp,
  RewriteKind,
  SavedView,
  ViewState
} from '../shared/protocol.ts'

interface Disposable {
  dispose(): void
}

interface FrameOrca {
  plugin: {
    request(name: string, input?: unknown, options?: { timeoutMs?: number }): Promise<any>
    on(event: string, handler: (payload: any) => void): Disposable
  }
  on(event: string, handler: (payload: any) => void): Disposable
  host: { has(method: string): boolean; call(method: string, params?: unknown): Promise<any> }
  document?: { get(): Promise<{ content: { kind: string; text?: string } }> }
}

export const orca = (globalThis as unknown as { orca: FrameOrca }).orca

const LONG = { timeoutMs: 120_000 }

export const api = {
  /** With `page`, the first page of history comes back with the repository, in the same trip. */
  resolve: (root?: string, workspaceId?: string | null, page?: FirstPageRequest): Promise<RepoResult> =>
    orca.plugin.request('repo.resolve', { ...(root ? { root } : {}), ...(workspaceId ? { workspaceId } : {}), ...(page ? { page } : {}) }, LONG),
  stamp: (root: string): Promise<RepoStamp> => orca.plugin.request('repo.stamp', { root }),
  saveView: (key: string, state: ViewState): Promise<{ ok: boolean }> => orca.plugin.request('view.save', { key, state }),
  loadView: (key: string): Promise<SavedView | null> => orca.plugin.request('view.load', { key }),
  refs: (root: string): Promise<RefsResult> => orca.plugin.request('repo.refs', { root }),
  watch: (root: string): Promise<{ ok: boolean }> => orca.plugin.request('repo.watch', { root }),
  page: (root: string, filter: LogFilter, skip: number, limit?: number): Promise<LogPage> =>
    orca.plugin.request('log.page', { root, filter, skip, ...(limit ? { limit } : {}) }, LONG),
  details: (root: string, hash: string): Promise<CommitDetails> => orca.plugin.request('commit.details', { root, hash }),
  diff: (root: string, hash: string, file: FileChange, wholeFile: boolean): Promise<FileDiff> =>
    orca.plugin.request(
      'file.diff',
      { root, hash, path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}), ...(file.base ? { base: file.base, tip: file.tip } : {}), wholeFile },
      LONG
    ),
  selectionFiles: (root: string, hashes: string[]): Promise<{ files: FileChange[] }> =>
    orca.plugin.request('selection.files', { root, hashes }, LONG),
  dirty: (root: string): Promise<{ files: string[] }> => orca.plugin.request('repo.dirty', { root }),
  uncommitted: (root: string): Promise<{ count: number }> => orca.plugin.request('repo.uncommitted', { root }),
  uncommittedFiles: (root: string): Promise<{ files: FileChange[] }> => orca.plugin.request('repo.uncommittedFiles', { root }, LONG),
  openFile: (root: string, path: string, workspaceId?: string | null): Promise<{ ok: boolean; reason?: string }> =>
    orca.plugin.request('file.open', { root, path, ...(workspaceId ? { workspaceId } : {}) }),
  pushCheck: (root: string, remote?: string, remoteBranch?: string): Promise<PushPlan> =>
    orca.plugin.request('push.check', { root, ...(remote ? { remote } : {}), ...(remoteBranch ? { remoteBranch } : {}) }, LONG),
  patch: (root: string, hashes: string[], path?: string, overwrite = false): Promise<PatchResult> =>
    orca.plugin.request('patch.create', { root, hashes, ...(path ? { path, overwrite } : {}) }, LONG),
  check: (root: string, kind: RewriteKind, hashes: string[]): Promise<CheckResult> =>
    orca.plugin.request('action.check', { root, kind, hashes }, LONG),
  run: (root: string, action: ActionRequest): Promise<ActionResult> => orca.plugin.request('action.run', { root, action }, LONG),
  openTab: (workspaceId?: string | null): Promise<{ ok: boolean; reason?: string }> =>
    orca.plugin.request('tab.open', workspaceId ? { workspaceId } : {}, LONG),
  openDiffTab: (request: DiffTabRequest): Promise<{ ok: boolean; reason?: string }> => orca.plugin.request('diff.openTab', request, LONG)
}

export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) return String((error as Error).message)
  return String(error)
}

/** Copies through a selection: frames refuse navigator.clipboard. Call it from a click or key press. */
export function copyText(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
  const focused = document.activeElement as HTMLElement | null
  document.body.append(area)
  area.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  area.remove()
  focused?.focus({ preventScroll: true })
  return copied
}
