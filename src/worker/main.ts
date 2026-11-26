import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { randomUUID } from 'node:crypto'
import type { DiffTabRequest, FileDiff, LogFilter, LogPage, RepoResult, RepoStamp } from '../shared/protocol.ts'
import { checkRewrite, dirtyFiles, runAction } from './actions.ts'
import { createMemo } from './cache.ts'
import { createGit, lastLines, type Git } from './git.ts'
import { readDetails, readLogPage, readRefs, readSelectionFiles, readUncommitted, readUncommittedFiles, WORKTREE } from './log.ts'
import { checkPush } from './push.ts'
import { closeRemoteShells, focusedWorkspace, remoteShell, remoteWorkspaceFor, resolveRepo, toplevel, type ListedWorkspace, type Workspace } from './repo.ts'
import { createOrcaCli, findOrcaCli } from './orcacli.ts'
import { readFileDiff } from './diff.ts'
import { DIFF_DIR, pickWorkspace, remoteDiffAnchor, remoteExcludeScript, remoteWriteScript, validDiffRequest, workspaceFilePath, writeDiffAnchor } from './difftab.ts'
import { shellQuote } from './remote.ts'
import { createPatch } from './patch.ts'
import { createViewStore } from './views.ts'
import { watchRepo, type RepoWatcher } from './watch.ts'
import { firstViewCalls } from './warmup.ts'

/** The Git Log tab's file in the workspace folder: Orca names a tab after its file, so it reads "Git Log". */
export const ANCHOR = 'Git Log.gitlog'
/** Tab files of earlier versions, removed when the tab opens. */
const OLD_ANCHORS = ['.orca-git-log.gitlog']
/** Every Git Log tab file, the + menu's untitled ones too: kept out of `git status` through info/exclude. */
export const TAB_FILES = '*.gitlog'
/** The custom editor that shows Git Log in a tab (`contributes.customEditors`). */
const LOG_TAB = 'log-tab'
/** Git on a remote host runs through a terminal: the log only reads there. */
export const REMOTE_READ_ONLY = 'This project is on a remote host: Git Log can show its history and changes, but cannot change it from here yet.'

let orcaApi: OrcaWorkerApi
const repos = new Map<string, Git>()
const watchers = new Map<string, Promise<RepoWatcher | null>>()

/** This run of the worker: change counts start over when it restarts. */
const SESSION = randomUUID()
/** Changes seen per repository root, so a reopened view knows whether it is still current. */
const changes = new Map<string, { refs: number; worktree: number }>()
const stampOf = (root: string): RepoStamp => ({ session: SESSION, refs: 0, worktree: 0, ...changes.get(root) })

/** A commit's diff never changes: the latest few are kept, and asked again (a prefetch, then the tab) only once. */
const commitDiffs = createMemo<FileDiff>(40)
/** Uncommitted changes do: kept just long enough for the diff tab to take what was fetched ahead for it. */
const WORKTREE_DIFF_MS = 3000
const worktreeDiffs = createMemo<FileDiff>(20, WORKTREE_DIFF_MS)

/** What each open view shows, and the answers it was served, for a frame Orca rebuilds. */
const views = createViewStore()

/** Repositories whose info/exclude already lists a pattern, as `root\0pattern`. */
const excluded = new Set<string>()

async function setting<T>(key: string, fallback: T): Promise<T> {
  try {
    const value = await orcaApi.settings.get(key)
    return (value ?? fallback) as T
  } catch {
    return fallback
  }
}

/** Entries of history per page: `limit` when the panel gives one, else the setting (1 to 2000). */
async function pageSize(limit?: unknown): Promise<number> {
  const size = Number(limit ?? (await setting('pageSize', 300)))
  return Math.min(2000, Math.max(1, Number.isFinite(size) ? Math.floor(size) : 300))
}

const gitPath = () => setting('gitPath', 'git').then((path) => (typeof path === 'string' && path.trim()) || 'git')

/** A git runner for a root a panel sends back; only roots this worker resolved are accepted. */
async function gitFor(root: unknown): Promise<Git> {
  if (typeof root !== 'string' || !root) throw new Error('Missing repository.')
  const known = repos.get(root)
  if (known) return known
  const path = await gitPath()
  if (!existsSync(root)) {
    // A remote repository this worker has not seen yet (it was restarted): found again by its workspace.
    const result = await resolveRepo(orcaApi, path, root)
    if (result.ok && result.git && result.repo.root === root) {
      repos.set(root, result.git)
      return result.git
    }
    throw new Error(result.ok ? `${root} is not a Git repository.` : result.reason)
  }
  if (resolve(root) !== root || (await toplevel(root, path)) !== root) throw new Error(`${root} is not a Git repository.`)
  const git = createGit(root, path)
  repos.set(root, git)
  return git
}

/** Adds `pattern` to the repository's info/exclude so the anchor never shows as untracked. */
async function exclude(git: Git, root: string, pattern: string): Promise<void> {
  const key = `${root}\0${pattern}`
  if (excluded.has(key)) return
  const file = resolve(root, (await git.out(['rev-parse', '--git-path', 'info/exclude'])).trim())
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (!current.split(/\r?\n/).includes(pattern)) {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`)
  }
  excluded.add(key)
}

/** The local workspace holding `root` (the one asked for first), else the focused one. */
async function workspaceFor(root: string, prefer?: string): Promise<Workspace | { reason: string }> {
  const { workspaces } = (await orcaApi.host.call('workspace.list', {})) as { workspaces: ListedWorkspace[] }
  return pickWorkspace(workspaces, root, prefer) ?? focusedWorkspace(orcaApi, prefer)
}

type Opened = { ok: boolean; reason?: string }

/**
 * Opens `path` (relative to the workspace folder) in an editor tab of Orca's window. A paired
 * server's workspace that the window cannot name to a plugin is opened with Orca's command line.
 */
async function openInEditor(workspace: Workspace, path: string): Promise<void> {
  try {
    await orcaApi.host.call('editor.open', { workspaceId: workspace.id, path })
    return
  } catch (error) {
    if (!workspace.environment) throw error
    orcaApi.log(`editor.open ${workspace.id}: ${error instanceof Error ? error.message : String(error)}; opening it with the command line`)
  }
  const command = await findOrcaCli()
  if (!command) throw new Error("Orca's command line (orca) was not found.")
  await createOrcaCli(command)(['file', 'open', '--environment', workspace.environment, '--worktree', workspace.selector!, '--focus', path])
}

/** Runs `script` (which writes the small file `path`) in a remote workspace through its helper terminal, then opens the file in an editor tab. */
async function openRemoteAnchor(workspace: Workspace, path: string, script: string): Promise<Opened> {
  const shell = await remoteShell(orcaApi, workspace)
  const written = await shell.run({ kind: 'sh', cwd: workspace.path, script })
  if (!written.ok) return { ok: false, reason: lastLines(written.stderr) || `Could not write ${path} on the remote host.` }
  await openInEditor(workspace, path)
  return { ok: true }
}

/** Reports a failed open in the plugin's log too (`orca plugin logs`), so it can be traced. */
async function logged(what: string, open: () => Promise<Opened>): Promise<Opened> {
  try {
    const result = await open()
    if (!result.ok) orcaApi.log(`${what}: ${result.reason}`)
    return result
  } catch (error) {
    orcaApi.log(`${what}: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

/** A diff tab for a repository on another host: its anchor is written there through the helper terminal, and Orca opens remote files itself. */
async function openRemoteDiffTab(req: DiffTabRequest): Promise<Opened> {
  const workspace = await remoteWorkspaceFor(orcaApi, req.root, req.workspaceId)
  if (!workspace) return { ok: false, reason: 'The workspace of this project is no longer open.' }
  const anchor = remoteDiffAnchor(req)
  return openRemoteAnchor(workspace, anchor.path, anchor.script)
}

/** The Git Log tab of a workspace on another host: its anchor is written there, like the diff tabs'. */
async function openRemoteTab(workspace: Workspace): Promise<Opened> {
  const resolved = await resolveRepo(orcaApi, await gitPath(), undefined, workspace.id)
  if (!resolved.ok) return { ok: false, reason: resolved.reason }
  const content = `${JSON.stringify({ root: resolved.repo.root, workspaceId: workspace.id }, null, 2)}\n`
  const removeOld = OLD_ANCHORS.map((file) => `rm -f ${shellQuote(file)}`)
  return openRemoteAnchor(workspace, ANCHOR, [...removeOld, remoteWriteScript(ANCHOR, content, TAB_FILES)].join('\n'))
}

/** Adds the tab files' pattern to the repository's info/exclude, on this computer or on its remote host. */
async function keepTabFilesOut(git: Git, root: string): Promise<void> {
  if (!git.remote) return exclude(git, root, TAB_FILES)
  const key = `${root}\0${TAB_FILES}`
  if (excluded.has(key)) return
  const workspace = await remoteWorkspaceFor(orcaApi, root)
  if (!workspace) return
  const result = await (await remoteShell(orcaApi, workspace)).run({ kind: 'sh', cwd: root, script: remoteExcludeScript(TAB_FILES) })
  if (!result.ok) throw new Error(lastLines(result.stderr) || 'git rev-parse failed')
  excluded.add(key)
}

async function openTab(prefer?: string): Promise<Opened> {
  const workspace = await focusedWorkspace(orcaApi, prefer)
  if ('reason' in workspace) return { ok: false, reason: workspace.reason }
  if (workspace.remote) return openRemoteTab(workspace)
  const path = await gitPath()
  const root = await toplevel(workspace.path, path)
  if (!root) return { ok: false, reason: 'This workspace is not a Git repository.' }
  // Ignored before the file exists, so it never shows as a change.
  await exclude(createGit(root, path), root, TAB_FILES)
  for (const old of OLD_ANCHORS) rmSync(join(workspace.path, old), { force: true })
  writeFileSync(join(workspace.path, ANCHOR), `${JSON.stringify({ root, workspaceId: workspace.id }, null, 2)}\n`)
  await orcaApi.host.call('editor.open', { workspaceId: workspace.id, path: ANCHOR })
  return { ok: true }
}

export default function activate(orca: OrcaWorkerApi): void {
  orcaApi = orca

  orca.panels.handle('repo.resolve', async (input, context): Promise<RepoResult> => {
    // On a remote host the first view's answers are fetched along with the lookup.
    const [size, path] = await Promise.all([pageSize(), gitPath()])
    const wanted = firstPageRequest(input?.page)
    const isTab = context?.panel?.contributionId === LOG_TAB
    let stamp: RepoStamp | undefined
    let page: Promise<LogPage | undefined> | undefined
    let tabFiles: Promise<void> | undefined
    // Started alongside the reads of HEAD and any operation in progress: one trip for the panel.
    const onRoot = (git: Git, root: string) => {
      stamp = stampOf(root)
      if (wanted) {
        page = (wanted.limit ? pageSize(wanted.limit) : Promise.resolve(size)).then((limit) => readLogPage(git, wanted.filter, 0, limit)).catch(() => undefined)
      }
      // A Git Log tab, maybe an untitled one from the + menu: its file stays out of `git status`.
      if (isTab) tabFiles = keepTabFilesOut(git, root).catch((error) => orca.log(`exclude ${TAB_FILES}: ${error instanceof Error ? error.message : String(error)}`))
    }
    const result = await resolveRepo(orca, path, input?.root, input?.workspaceId, (root) => firstViewCalls(root, size), onRoot)
    await tabFiles
    if (!result.ok) return result
    if (result.git) repos.set(result.repo.root, result.git)
    const first = page ? await page : undefined
    if (first && wanted) views.recordPage(result.repo.root, wanted.filter, 0, first)
    return { ok: true, repo: result.repo, ...(stamp ? { stamp } : {}), ...(first ? { page: first } : {}) }
  })

  orca.panels.handle('repo.stamp', async ({ root }) => {
    if (typeof root !== 'string' || !root) throw new Error('Missing repository.')
    return stampOf(root)
  })

  orca.panels.handle('repo.refs', async ({ root }) => {
    const refs = await readRefs(await gitFor(root))
    views.recordRefs(root, refs)
    return refs
  })

  orca.panels.handle('view.save', async ({ key, state }) => ({ ok: views.save(key, state) }))

  orca.panels.handle('view.load', async ({ key }) => views.load(key))

  orca.panels.handle('repo.watch', async ({ root }) => {
    const git = await gitFor(root)
    // No file watching on another host: the panel refreshes when it gets focus or on request.
    if (git.remote) return { ok: false }
    if (!watchers.has(root)) {
      watchers.set(
        root,
        watchRepo(
          git,
          root,
          () => changed(root),
          undefined,
          () => worktreeChanged(root)
        ).catch(() => null)
      )
    }
    return { ok: (await watchers.get(root)) !== null }
  })

  orca.panels.handle('log.page', async ({ root, filter, skip, limit }) => {
    const size = await pageSize(limit)
    const from = Math.max(0, Math.floor(Number(skip) || 0))
    const page = await readLogPage(await gitFor(root), filter ?? {}, from, size)
    views.recordPage(root, filter, from, page)
    return page
  })

  orca.panels.handle('commit.details', async ({ root, hash }) => {
    const details = await readDetails(await gitFor(root), hash)
    views.recordDetails(root, details)
    return details
  })

  orca.panels.handle('file.diff', async ({ root, hash, path, oldPath, base, tip, wholeFile }) => {
    const git = await gitFor(root)
    const range = base || tip ? { base: String(base), tip: String(tip) } : undefined
    const key = JSON.stringify([root, hash, path, oldPath ?? '', range?.base ?? '', range?.tip ?? '', Boolean(wholeFile)])
    const memo = hash === WORKTREE ? worktreeDiffs : commitDiffs
    return memo.get(key, () => readFileDiff(git, hash, path, oldPath, Boolean(wholeFile), range))
  })

  orca.panels.handle('selection.files', async ({ root, hashes }) => ({ files: await readSelectionFiles(await gitFor(root), hashes) }))

  orca.panels.handle('repo.dirty', async ({ root }) => ({ files: await dirtyFiles(await gitFor(root)) }))

  orca.panels.handle('repo.uncommitted', async ({ root }) => ({ count: await readUncommitted(await gitFor(root)) }))

  orca.panels.handle('repo.uncommittedFiles', async ({ root }) => {
    const files = await readUncommittedFiles(await gitFor(root))
    views.recordUncommittedFiles(root, files)
    return { files }
  })

  orca.panels.handle('push.check', async ({ root, remote, remoteBranch }) => {
    const git = await gitFor(root)
    if (git.remote) return { ok: false as const, reason: REMOTE_READ_ONLY }
    return checkPush(git, typeof remote === 'string' ? remote : undefined, typeof remoteBranch === 'string' ? remoteBranch : undefined)
  })

  orca.panels.handle('patch.create', async ({ root, hashes, path, overwrite }) => {
    const git = await gitFor(root)
    if (git.remote) return { ok: false as const, reason: REMOTE_READ_ONLY }
    return createPatch(git, root, hashes, path, Boolean(overwrite))
  })

  orca.panels.handle('action.check', async ({ root, kind, hashes }) => {
    const git = await gitFor(root)
    if (git.remote) return { ok: false as const, reason: REMOTE_READ_ONLY }
    return checkRewrite(git, kind, hashes)
  })

  orca.panels.handle('action.run', async ({ root, action }) => {
    const git = await gitFor(root)
    if (git.remote) return { ok: false, message: REMOTE_READ_ONLY }
    const result = await runAction(git, action)
    changed(root)
    return result
  })

  orca.panels.handle('tab.open', (input) => logged('tab.open', () => openTab(input?.workspaceId)))

  orca.panels.handle('diff.openTab', async (input) => {
    const req = validDiffRequest(input)
    const git = await gitFor(req.root)
    if (git.remote) return logged('diff.openTab', () => openRemoteDiffTab(req))
    const workspace = await workspaceFor(req.root, req.workspaceId)
    if ('reason' in workspace) return { ok: false, reason: workspace.reason }
    const path = writeDiffAnchor(workspace.path, req)
    await exclude(git, req.root, `${DIFF_DIR}/`)
    await orca.host.call('editor.open', { workspaceId: workspace.id, path })
    return { ok: true }
  })

  orca.panels.handle('file.open', async ({ root, path, workspaceId }) => {
    const git = await gitFor(root)
    const prefer = typeof workspaceId === 'string' ? workspaceId : undefined
    const workspace = git.remote ? await remoteWorkspaceFor(orca, root, prefer) : await workspaceFor(root, prefer)
    if (!workspace) return { ok: false, reason: 'The workspace of this project is no longer open.' }
    if ('reason' in workspace) return { ok: false, reason: workspace.reason }
    const relative = workspaceFilePath(workspace.path, root, path, Boolean(git.remote))
    if (!relative) return { ok: false, reason: `${path} is not inside the open workspace.` }
    if (!git.remote && !existsSync(join(workspace.path, relative))) return { ok: false, reason: `${path} no longer exists.` }
    await openInEditor(workspace, relative)
    return { ok: true }
  })

  orca.commands.register('open-tab', async () => {
    const result = await openTab()
    if (!result.ok) orca.log(`open-tab: ${result.reason}`)
    return result
  })
}

/** The repository's refs or HEAD changed: every open view of it refreshes. */
function changed(root: string): void {
  const { refs, worktree } = stampOf(root)
  changes.set(root, { refs: refs + 1, worktree })
  worktreeDiffs.clear()
  views.forgetDetails(root)
  orcaApi.panels.post('repo.changed', { root, stamp: stampOf(root) })
}

/** A file of its work tree changed: only its uncommitted changes need reading again. */
function worktreeChanged(root: string): void {
  const { refs, worktree } = stampOf(root)
  changes.set(root, { refs, worktree: worktree + 1 })
  worktreeDiffs.clear()
  views.forgetUncommitted(root)
  orcaApi.panels.post('repo.worktree', { root, stamp: stampOf(root) })
}

/** The first page `repo.resolve` is asked to bring back, when the request names a valid one. */
function firstPageRequest(input: unknown): { filter: LogFilter; limit?: number } | null {
  if (!input || typeof input !== 'object') return null
  const { filter, limit } = input as { filter?: unknown; limit?: unknown }
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return null
  return { filter: filter as LogFilter, ...(typeof limit === 'number' && limit > 0 ? { limit } : {}) }
}

export async function deactivate(): Promise<void> {
  for (const watcher of watchers.values()) void watcher.then((w) => w?.close())
  watchers.clear()
  repos.clear()
  changes.clear()
  excluded.clear()
  commitDiffs.clear()
  worktreeDiffs.clear()
  views.clear()
  await closeRemoteShells()
}
