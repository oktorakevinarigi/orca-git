import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import nodePath, { isAbsolute, join, posix, relative } from 'node:path'
import type { DiffTabRequest, FileChange } from '../shared/protocol.ts'
import { WORKTREE } from './log.ts'
import { shellQuote } from './remote.ts'
import type { ListedWorkspace, Workspace } from './repo.ts'

/** Folder, inside the workspace, holding the small files that diff tabs open. */
export const DIFF_DIR = '.orca-git-log'
const KEEP = 40

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const safe = (text: string) => text.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || 'file'

/** `name.ts @1a2b3c4d.gitdiff`; the parent folder is added when another changed file has the same name. */
export function diffAnchorName(files: FileChange[], index: number, hash: string): string {
  const path = files[index].path
  const name = baseName(path)
  const parts = path.split('/')
  const twin = files.some((f, i) => i !== index && baseName(f.path) === name) && parts.length > 1
  const revision = hash === WORKTREE ? ' (uncommitted)' : ` @${hash.slice(0, 8)}`
  return `${safe(name)}${twin ? ` (${safe(parts[parts.length - 2])})` : ''}${revision}.gitdiff`
}

/**
 * `path` (relative to the repository at `root`) as a path relative to the workspace folder, for
 * `editor.open`; null when it is not a plain relative path or lies outside the workspace.
 */
export function workspaceFilePath(workspacePath: string, root: string, path: string, remote = false): string | null {
  // A remote host's paths are POSIX paths, whatever this computer uses.
  const paths = remote ? posix : nodePath
  if (typeof path !== 'string' || !path || path.length > 4096 || paths.isAbsolute(path) || path.includes('\0')) return null
  const outside = (rel: string) => !rel || rel === '..' || rel.startsWith(`..${paths.sep}`) || paths.isAbsolute(rel)
  const full = paths.resolve(root, path)
  const inWorkspace = paths.relative(workspacePath, full)
  if (outside(paths.relative(root, full)) || outside(inWorkspace)) return null
  return inWorkspace.split(paths.sep).join('/')
}

export function validDiffRequest(input: unknown): DiffTabRequest {
  const req = (input ?? {}) as DiffTabRequest
  const isText = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length < 4096
  if (!isText(req.root) || !/^[0-9a-f]{4,64}$/i.test(String(req.hash))) throw new Error('Invalid diff request.')
  if (!Array.isArray(req.files) || !req.files.length || req.files.length > 20_000) throw new Error('Invalid diff request.')
  const files = req.files.map((f) => {
    if (!isText(f?.path) || !isText(f?.status) || (f.oldPath !== undefined && !isText(f.oldPath))) throw new Error('Invalid diff request.')
    const commit = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
    if ((f.base !== undefined || f.tip !== undefined) && !(commit(f.base) && commit(f.tip))) throw new Error('Invalid diff request.')
    return { status: f.status, path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), ...(f.base ? { base: f.base, tip: f.tip } : {}) }
  })
  const index = Math.floor(Number(req.index))
  if (!(index >= 0 && index < files.length)) throw new Error('Invalid diff request.')
  return { root: req.root, hash: req.hash, files, index, ...(isText(req.workspaceId) ? { workspaceId: req.workspaceId } : {}) }
}

/** The local workspace to put the anchor in: the one asked for, else the one rooted at `root`. */
export function pickWorkspace(workspaces: ListedWorkspace[], root: string, prefer?: string): Workspace | null {
  const local = workspaces.filter((w) => (!w.hostId || w.hostId === 'local') && existsSync(w.path))
  const at = (w: ListedWorkspace) => relative(root, w.path)
  const inside = (w: ListedWorkspace) => !at(w).startsWith('..') && !isAbsolute(at(w))
  const found = local.find((w) => w.id === prefer && inside(w)) ?? local.find((w) => at(w) === '') ?? local.find(inside)
  return found ? { id: found.id, path: found.path } : null
}

/** What a diff tab's anchor file holds: the request, without the workspace it was opened from. */
export function diffAnchorContent(req: DiffTabRequest): string {
  const { workspaceId: _, ...content } = req
  return `${JSON.stringify(content)}\n`
}

/**
 * The sh script, run in a workspace folder on a remote host, that writes `content` to `file`
 * (relative to it) and keeps `exclude` out of `git status`, as the local writes and exclude do on
 * this computer; with `keep`, the file's folder keeps only that many newest `.gitdiff` files.
 */
export function remoteWriteScript(file: string, content: string, exclude: string, keep?: number): string {
  const slash = file.lastIndexOf('/')
  const dir = slash > 0 ? shellQuote(file.slice(0, slash)) : null
  return [
    // Ignored before the file exists, so it never shows as a change.
    remoteExcludeScript(exclude),
    ...(dir ? [`mkdir -p ${dir} || exit 1`] : []),
    `printf %s ${Buffer.from(content, 'utf8').toString('base64')} | base64 -d >${shellQuote(file)} || exit 1`,
    ...(dir && keep ? [`ls -t ${dir} | grep '[.]gitdiff$' | tail -n +${keep + 1} | while IFS= read -r f; do rm -f ${dir}/"$f"; done`] : [])
  ].join('\n')
}

/** The sh line that adds `pattern` to the repository's info/exclude once (run inside the repository). */
export function remoteExcludeScript(pattern: string): string {
  const quoted = shellQuote(pattern)
  return `x=$(g rev-parse --git-path info/exclude) && mkdir -p "$(dirname "$x")" && { grep -qxF ${quoted} "$x" 2>/dev/null || printf '%s\\n' ${quoted} >>"$x"; }`
}

/** A diff tab's anchor on a remote host: the script that writes it there, and the path to open. */
export function remoteDiffAnchor(req: DiffTabRequest): { script: string; path: string } {
  const path = `${DIFF_DIR}/${diffAnchorName(req.files, req.index, req.hash)}`
  return { script: remoteWriteScript(path, diffAnchorContent(req), `${DIFF_DIR}/`, KEEP), path }
}

/** Writes the anchor a diff tab opens, removing the oldest ones beyond a few dozen. */
export function writeDiffAnchor(workspacePath: string, req: DiffTabRequest): string {
  const dir = join(workspacePath, DIFF_DIR)
  mkdirSync(dir, { recursive: true })
  const name = diffAnchorName(req.files, req.index, req.hash)
  writeFileSync(join(dir, name), diffAnchorContent(req))
  const old = readdirSync(dir)
    .filter((file) => file.endsWith('.gitdiff') && file !== name)
    .map((file) => ({ file, time: statSync(join(dir, file)).mtimeMs }))
    .sort((a, b) => b.time - a.time)
    .slice(KEEP - 1)
  for (const { file } of old) {
    try {
      unlinkSync(join(dir, file))
    } catch {
      // Still open somewhere, or already gone: harmless.
    }
  }
  return `${DIFF_DIR}/${name}`
}
