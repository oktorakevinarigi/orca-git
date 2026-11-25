import { watch, type FSWatcher } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import type { Git } from './git.ts'

// Only these paths (relative to a git dir) change what the log shows.
const RELEVANT = /^(HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|packed-refs|refs|rebase-merge|rebase-apply|worktrees)(\/|$)/

export function isRelevant(file: string | null): boolean {
  if (!file) return true
  const path = file.split(sep).join('/')
  return !path.endsWith('.lock') && RELEVANT.test(path)
}

/** Work-tree paths (relative to its root) that can change the uncommitted changes count. */
export function isWorktreeRelevant(file: string | null): boolean {
  if (!file) return true
  const top = file.split(sep).join('/').split('/')[0]
  // The git dir is watched on its own; the plugin's own anchor files are excluded from git.
  return top !== '.git' && !top.startsWith('.orca-git-log')
}

export interface RepoWatcher {
  close(): void
}

/** Waits for `delayMs` of quiet after the last call before running `run`. */
function debounce(run: () => void, delayMs: number): { fire(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    fire() {
      clearTimeout(timer)
      timer = setTimeout(run, delayMs)
    },
    cancel: () => clearTimeout(timer)
  }
}

/** Watches recursively, or not at all where recursive watching is unavailable (older Linux Node). */
function watchTree(dir: string, onFile: (file: string | null) => void): FSWatcher | null {
  try {
    const watcher = watch(dir, { recursive: true }, (_event, file) => onFile(file ? file.toString() : null))
    watcher.on('error', () => watcher.close())
    return watcher
  } catch {
    return null
  }
}

const WORKTREE_DELAY_MS = 1000

/**
 * Calls `onChange` (debounced) when refs, HEAD or a sequencer state of the repository change, and
 * `onWorktree` when a file of the work tree changes. Without recursive watching, the panel still
 * refreshes on focus.
 */
export async function watchRepo(
  git: Git,
  root: string,
  onChange: () => void,
  delayMs = 400,
  onWorktree?: () => void
): Promise<RepoWatcher> {
  const [gitDir, commonDir] = (await git.out(['rev-parse', '--git-dir', '--git-common-dir']))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((dir) => resolve(root, dir))
  const refsChanged = debounce(onChange, delayMs)
  const worktreeChanged = onWorktree ? debounce(onWorktree, WORKTREE_DELAY_MS) : null
  const watchers: FSWatcher[] = []
  const dirs = [commonDir]
  if (gitDir && gitDir !== commonDir && relative(commonDir, gitDir).startsWith('..')) dirs.push(gitDir)
  for (const dir of dirs) {
    const watcher = watchTree(dir, (file) => isRelevant(file) && refsChanged.fire())
    if (watcher) watchers.push(watcher)
  }
  if (worktreeChanged) {
    const watcher = watchTree(root, (file) => isWorktreeRelevant(file) && worktreeChanged.fire())
    if (watcher) watchers.push(watcher)
  }
  return {
    close() {
      refsChanged.cancel()
      worktreeChanged?.cancel()
      watchers.forEach((w) => w.close())
    }
  }
}
