import { existsSync } from 'node:fs'
import { basename, isAbsolute, resolve } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { RepoInfo, RepoResult, WorkspaceChoice } from '../shared/protocol.ts'
import { createGit, type Git } from './git.ts'
import { readHead } from './log.ts'
import { operationInProgress } from './rebase.ts'
import { cliTerminalHost, createOrcaCli, findOrcaCli, matchServerWorkspace, serverWorkspaces, type OrcaCli } from './orcacli.ts'
import { createRemoteGit, RemoteShell, type RemoteCall, type TerminalHost } from './remote.ts'

/** Calls to fetch ahead, with the repository lookup, for the first view of the repository at `root`. */
export type WarmUp = (root: string) => RemoteCall[]

/** Called as soon as the repository's root is known, before its HEAD is read: work to start alongside. */
export type OnRoot = (git: Git, root: string) => void

export interface Workspace {
  /** Its id in Orca's window (what `editor.open` takes). */
  id: string
  path: string
  /** On another host (SSH or a paired Orca server): its files and git are reached through a terminal. */
  remote?: boolean
  /** On a paired Orca server, reached with Orca's command line: the server (`--environment`)... */
  environment?: string
  /** ...and the workspace there (`--worktree`). */
  selector?: string
}

export interface ListedWorkspace {
  id: string
  name: string
  path: string
  branch: string | null
  hostId: string | null
}

interface Context {
  /** Since host API 1.x: the same id `workspace.list` gives, when the workspace is in it. */
  workspaceId?: string
  branch: string
  displayName: string
  terminals?: { id: string; title?: string }[]
}

export type Match = { workspace: ListedWorkspace } | { remote: ListedWorkspace } | { ambiguous: ListedWorkspace[] } | null

const shortBranch = (branch: string | null | undefined) => (branch ?? '').replace(/^refs\/heads\//, '')
const slashes = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const isLocal = (w: ListedWorkspace) => (!w.hostId || w.hostId === 'local') && existsSync(w.path)

/** True when `text` names `path` (Windows or MSYS spelling), not just a longer sibling path. */
export function mentions(text: string, path: string): boolean {
  const forms = [path]
  const drive = /^([a-z]):(\/.*)?$/.exec(path)
  if (drive) forms.push(`/${drive[1]}${drive[2] ?? ''}`)
  // A WSL shell shows `/home/me/repo` or `~/repo` for `\\wsl.localhost\<distro>\home\me\repo`.
  const wsl = /^\/\/wsl(?:\.localhost|\$)\/[^/]+(\/.*)$/.exec(path)
  if (wsl) {
    forms.push(wsl[1])
    const home = /^\/(?:home\/[^/]+|root)(\/.*)$/.exec(wsl[1])
    if (home) forms.push(`~${home[1]}`)
  }
  for (const form of forms) {
    for (let at = text.indexOf(form); at >= 0; at = text.indexOf(form, at + 1)) {
      if (!/[\w.-]/.test(text[at + form.length] ?? '')) return true
    }
  }
  return false
}

/**
 * Picks the listed workspace that `workspace.readContext` describes. The context carries no id or
 * path, so same-named workspaces are told apart by branch, then by the paths their terminal titles
 * show (shells usually print their cwd there), then by `prefer` (a previous choice).
 */
export function matchWorkspace(context: Context, workspaces: ListedWorkspace[], prefer?: string | null): Match {
  const named = workspaces.filter((w) => w.name === context.displayName)
  let pool = named.length ? named : workspaces.filter((w) => basename(w.path) === context.displayName)
  const sameBranch = pool.filter((w) => shortBranch(w.branch) === shortBranch(context.branch))
  if (sameBranch.length) pool = sameBranch
  const local = pool.filter(isLocal)
  if (!local.length) {
    // Only on other hosts: one of them, or the one picked before, else ask.
    const picked = pool.find((w) => w.id === prefer) ?? (pool.length === 1 ? pool[0] : undefined)
    return picked ? { remote: picked } : pool.length ? { ambiguous: pool } : null
  }
  if (local.length === 1) return { workspace: local[0] }

  const titles = (context.terminals ?? []).map((t) => slashes(t.title ?? '')).filter(Boolean)
  const shown = local.filter((w) => titles.some((title) => mentions(title, slashes(w.path))))
  if (shown.length === 1) return { workspace: shown[0] }
  const preferred = local.find((w) => w.id === prefer)
  if (preferred) return { workspace: preferred }
  return { ambiguous: shown.length ? shown : local }
}

let lastChoice: string | null = null

export async function focusedWorkspace(
  orca: OrcaWorkerApi,
  prefer?: string | null
): Promise<Workspace | { reason: string; choices?: WorkspaceChoice[] }> {
  const context = (await orca.host.call('workspace.readContext', {})) as Context | null
  if (!context) return { reason: 'Open a workspace to see its Git log.' }
  const { workspaces } = (await orca.host.call('workspace.list', {})) as { workspaces: ListedWorkspace[] }
  if (context.workspaceId) {
    // The focused workspace by its id: never a same-named copy on another host.
    const exact = workspaces.find((w) => w.id === context.workspaceId)
    if (exact) {
      lastChoice = exact.id
      return isLocal(exact) ? { id: exact.id, path: exact.path } : { id: exact.id, path: exact.path, remote: true }
    }
    // Not covered by this computer's Orca: a workspace of a paired Orca server.
    const server = await serverWorkspace({ workspaceId: context.workspaceId, displayName: context.displayName, branch: context.branch })
    if (server) return server
    return {
      reason: `Git Log cannot reach "${context.displayName}": it is on a paired Orca server, which Git Log reaches with Orca's command line (orca), and that was not found or does not list it.`
    }
  }
  const match = matchWorkspace(context, workspaces, prefer ?? lastChoice)
  if (!match) return { reason: `Workspace "${context.displayName}" was not found.` }
  if ('remote' in match) {
    lastChoice = match.remote.id
    return { id: match.remote.id, path: match.remote.path, remote: true }
  }
  if ('ambiguous' in match) {
    return {
      reason: `Several workspaces are named "${context.displayName}". Pick the one you are in:`,
      choices: match.ambiguous.map(({ id, name, path, branch }) => ({ id, name, path: path.replace(/(.)[\\/]+$/, '$1'), branch: shortBranch(branch) }))
    }
  }
  lastChoice = match.workspace.id
  return { id: match.workspace.id, path: match.workspace.path }
}

let cli: Promise<OrcaCli | null> | null = null
const orcaCli = () => (cli ??= findOrcaCli().then((command) => (command ? createOrcaCli(command) : null)))

/** A paired Orca server's workspace, found with Orca's command line; null when none matches (or there is no command line). */
async function serverWorkspace(want: { workspaceId?: string | null; path?: string; displayName?: string; branch?: string | null }): Promise<Workspace | null> {
  // A workspace keeps its id: looked up once, not on every refresh (each lookup asks the server).
  const known = want.workspaceId ? serverById.get(want.workspaceId) : undefined
  if (known) return known
  const run = await orcaCli()
  if (!run) return null
  const found = matchServerWorkspace(await serverWorkspaces(run).catch(() => []), want)
  if (!found) return null
  const workspace = { id: want.workspaceId ?? found.selector, path: found.path, remote: true, environment: found.environment, selector: found.selector }
  if (want.workspaceId) serverById.set(want.workspaceId, workspace)
  return workspace
}

/** Paired-server workspaces found so far, by the id the window gives them. */
const serverById = new Map<string, Workspace>()

/** Remote repositories resolved so far, by root, with the workspace they were found in. */
const remoteRoots = new Map<string, Workspace>()

/** The workspace on another host that holds `root` (the one asked for first); null when none does. */
export async function remoteWorkspaceFor(orca: OrcaWorkerApi, root: string, prefer?: string | null): Promise<Workspace | null> {
  const known = remoteRoots.get(root)
  if (known) return known
  const { workspaces } = (await orca.host.call('workspace.list', {})) as { workspaces: ListedWorkspace[] }
  const holds = (w: ListedWorkspace) => {
    const path = w.path.replace(/\/+$/, '')
    return root === path || root.startsWith(`${path}/`) || path.startsWith(`${root}/`)
  }
  const remote = workspaces.filter((w) => !isLocal(w) && holds(w))
  const found = remote.find((w) => w.id === prefer) ?? remote[0]
  if (found) return { id: found.id, path: found.path, remote: true }
  return serverWorkspace({ path: root, workspaceId: prefer })
}

const shells = new Map<string, RemoteShell>()

/**
 * The helper terminal of a workspace on another host, shared by every repository in it: through
 * the host API for this computer's SSH targets, through Orca's command line on a paired server.
 */
export async function remoteShell(orca: OrcaWorkerApi, workspace: Workspace): Promise<RemoteShell> {
  const key = workspace.environment ? `${workspace.environment}|${workspace.selector}` : workspace.id
  let shell = shells.get(key)
  if (shell) return shell
  if (workspace.environment) {
    const run = await orcaCli()
    if (!run) throw new Error("Orca's command line (orca) was not found.")
    // Each command-line call already takes about half a second: read again soon after typing.
    shell = new RemoteShell(cliTerminalHost(run, workspace.environment), workspace.selector!, { pollMs: 20, timeoutMs: 90_000 })
  } else {
    shell = new RemoteShell(orca.host as TerminalHost, workspace.id)
  }
  shells.set(key, shell)
  return shell
}

export async function closeRemoteShells(): Promise<void> {
  const all = [...shells.values()]
  shells.clear()
  await Promise.all(all.map((shell) => shell.close()))
}

/** The repository holding `folder` (the workspace's own by default) on its host, checked by git there. */
async function resolveRemote(
  orca: OrcaWorkerApi,
  workspace: Workspace,
  folder = workspace.path,
  warm?: WarmUp,
  onRoot?: OnRoot
): Promise<RepoResult & { git?: Git }> {
  let top
  let shell: RemoteShell
  try {
    shell = await remoteShell(orca, workspace)
    // The first view's calls ride along with the lookup (the folder is usually the repository's root).
    if (warm) shell.warm(warm(folder))
    top = await createRemoteGit(shell, folder).run(['rev-parse', '--show-toplevel'])
  } catch (error) {
    return { ok: false, reason: `Could not run git on the remote host: ${error instanceof Error ? error.message : String(error)}` }
  }
  const root = top.stdout.trim()
  if (!top.ok || !root) return { ok: false, reason: `${basename(folder)} is not a Git repository.` }
  remoteRoots.set(root, workspace)
  const git = createRemoteGit(shell, root)
  onRoot?.(git, root)
  return { ok: true, repo: { ...(await describeRepo(git, root, workspace.id)), remote: true }, git }
}

/** Top-level folders found so far, by git binary and folder: a folder stays in the same repository. */
const toplevels = new Map<string, string>()

export async function toplevel(path: string, gitPath: string): Promise<string | null> {
  const key = `${gitPath}\0${path}`
  const known = toplevels.get(key)
  // Checked again when the repository's folder is gone.
  if (known && existsSync(known)) return known
  const result = await createGit(path, gitPath).run(['rev-parse', '--show-toplevel'])
  const root = result.ok ? resolve(result.stdout.trim()) : null
  if (root) toplevels.set(key, root)
  else toplevels.delete(key)
  return root
}

export async function describeRepo(git: Git, root: string, workspaceId: string | null): Promise<RepoInfo> {
  const [head, operation] = await Promise.all([readHead(git), operationInProgress(git)])
  return { root, name: basename(root), workspaceId, head, operation }
}

export async function resolveRepo(
  orca: OrcaWorkerApi,
  gitPath: string,
  requested?: string,
  prefer?: string,
  warm?: WarmUp,
  onRoot?: OnRoot
): Promise<RepoResult & { git?: Git }> {
  let path: string
  let workspaceId: string | null = null
  if (requested) {
    if (!isAbsolute(requested) && !requested.startsWith('/')) return { ok: false, reason: `${requested} no longer exists.` }
    if (!existsSync(requested)) {
      // Not on this computer: a repository in a workspace on another host.
      const remote = await remoteWorkspaceFor(orca, requested, prefer)
      if (!remote) return { ok: false, reason: `${requested} no longer exists.` }
      return resolveRemote(orca, remote, requested, warm, onRoot)
    }
    path = requested
  } else {
    const workspace = await focusedWorkspace(orca, prefer)
    if ('reason' in workspace) return { ok: false, ...workspace }
    if (workspace.remote) return resolveRemote(orca, workspace, workspace.path, warm, onRoot)
    path = workspace.path
    workspaceId = workspace.id
  }
  const root = await toplevel(path, gitPath)
  if (!root) return { ok: false, reason: `${basename(path)} is not a Git repository.` }
  const git = createGit(root, gitPath)
  onRoot?.(git, root)
  return { ok: true, repo: await describeRepo(git, root, workspaceId), git }
}
