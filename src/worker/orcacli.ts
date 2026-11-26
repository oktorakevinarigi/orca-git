// Workspaces of a paired Orca server. The host API a plugin gets only reaches workspaces this
// computer's Orca runtime covers (its own and its SSH targets), not a paired server's, but Orca's
// command line does (`--environment`): it lists the server's workspaces and opens, types into
// and reads terminals there, which is all the remote transport needs.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TerminalHost } from './remote.ts'

/** Runs one `orca` command with `--json` and returns its `result`; throws its error message. */
export type OrcaCli = (args: string[]) => Promise<any>

export interface ServerWorkspace {
  /** The saved paired server (its id), for `--environment`. */
  environment: string
  /** How the CLI names the workspace there: `identity:<key>`, else `id:<id>`. */
  selector: string
  path: string
  displayName: string
  branch: string | null
  /** The workspace's identity instance id, the same whichever host lists it. */
  instanceId: string | null
}

const CLI_TIMEOUT_MS = 60_000

/** Where Orca's command line may be: the one this Orca session names, `orca` on PATH, then the app's own. */
export function cliCandidates(env: Record<string, string | undefined> = process.env, platform = process.platform): string[] {
  const app = join('Orca.app', 'Contents', 'Resources', 'bin', 'orca')
  return [
    env.ORCA_CLI_COMMAND,
    'orca',
    ...(platform === 'darwin' ? [join('/Applications', app), join(homedir(), 'Applications', app)] : []),
    ...(platform === 'win32' && env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Programs', 'Orca', 'resources', 'bin', 'orca.cmd')] : []),
    ...(platform === 'linux' ? ['/opt/Orca/resources/bin/orca', '/usr/lib/orca/resources/bin/orca'] : [])
  ].filter((command): command is string => Boolean(command) && (command === 'orca' || existsSync(command!)))
}

const exec = (command: string, args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      command,
      args,
      { timeout: CLI_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true, shell: process.platform === 'win32' && command === 'orca' },
      (error, stdout, stderr) => resolve({ code: error ? (typeof (error as any).code === 'number' ? (error as any).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    )
  })

let found: Promise<string | null> | null = null

/** The first command line that answers `--version` (a launcher copied out of the app does not). */
export function findOrcaCli(): Promise<string | null> {
  found ??= (async () => {
    for (const command of cliCandidates()) if ((await exec(command, ['--version'])).code === 0) return command
    return null
  })()
  return found
}

export function createOrcaCli(command: string): OrcaCli {
  return async (args) => {
    const { stdout, stderr } = await exec(command, [...args, '--json'])
    let answer: any
    try {
      answer = JSON.parse(stdout)
    } catch {
      throw new Error(stderr.trim() || stdout.trim() || `orca ${args[0]} failed`)
    }
    if (!answer?.ok) throw new Error(answer?.error?.message ?? `orca ${args[0]} failed`)
    return answer.result
  }
}

/** Every workspace of every saved paired server that answers (one that is offline is skipped). */
export async function serverWorkspaces(cli: OrcaCli): Promise<ServerWorkspace[]> {
  const { environments = [] } = (await cli(['environment', 'list'])) ?? {}
  const lists = await Promise.all(
    (environments as { id: string }[]).map(async ({ id }) => {
      try {
        const { worktrees = [] } = (await cli(['worktree', 'list', '--environment', id, '--limit', '500'])) ?? {}
        return (worktrees as any[]).map(
          (w): ServerWorkspace => ({
            environment: id,
            selector: w.identity?.key ? `identity:${w.identity.key}` : `id:${w.id}`,
            path: String(w.path ?? ''),
            displayName: String(w.displayName ?? ''),
            branch: typeof w.branch === 'string' ? w.branch.replace(/^refs\/heads\//, '') : null,
            instanceId: w.identity?.instanceId ?? null
          })
        )
      } catch {
        return []
      }
    })
  )
  return lists.flat().filter((w) => w.path)
}

/** The identity instance id inside a workspace id such as `identity:wt2:runtime:<host>:<instance>`. */
const instanceOf = (workspaceId: string) => (workspaceId.startsWith('identity:') ? workspaceId.slice(workspaceId.lastIndexOf(':') + 1) : null)

/**
 * The server workspace that the focused workspace (by its id) or a repository path names: by the
 * identity instance first, then by path; by name and branch only when that leaves one.
 */
export function matchServerWorkspace(
  list: ServerWorkspace[],
  want: { workspaceId?: string | null; path?: string; displayName?: string; branch?: string | null }
): ServerWorkspace | null {
  const instance = want.workspaceId ? instanceOf(want.workspaceId) : null
  const byInstance = instance ? list.find((w) => w.instanceId === instance) : undefined
  if (byInstance) return byInstance
  if (want.path) {
    const path = want.path
    const holds = list.filter((w) => path === w.path || path.startsWith(`${w.path.replace(/\/+$/, '')}/`))
    if (holds.length) return holds.sort((a, b) => b.path.length - a.path.length)[0]
  }
  if (want.displayName) {
    const named = list.filter((w) => w.displayName === want.displayName && (!want.branch || w.branch === want.branch.replace(/^refs\/heads\//, '')))
    if (named.length === 1) return named[0]
  }
  return null
}

/** The terminal methods the remote transport uses, done with the command line on a paired server. */
export function cliTerminalHost(cli: OrcaCli, environment: string): TerminalHost {
  const on = ['--environment', environment]
  return {
    async call(method, params) {
      const p = (params ?? {}) as Record<string, any>
      switch (method) {
        case 'terminal.create': {
          const result = await cli(['terminal', 'create', ...on, '--worktree', p.workspaceId, ...(p.title ? ['--title', p.title] : []), ...(p.command ? ['--command', p.command] : [])])
          return { terminalId: result.terminal.handle }
        }
        case 'terminal.sendText':
          // A newline in the text presses Enter at once; `--enter` waits a moment first (0.5 s against 1.3 s).
          await cli(['terminal', 'send', ...on, '--terminal', p.terminalId, '--text', p.enter ? `${p.text}\n` : p.text])
          return { accepted: true }
        case 'terminal.read': {
          const result = await cli(['terminal', 'read', ...on, '--terminal', p.terminalId, '--limit', String(p.maxLines ?? 200)])
          return { lines: result.terminal?.tail ?? [] }
        }
        case 'terminal.close':
          await cli(['terminal', 'close', ...on, '--terminal', p.terminalId])
          return {}
        default:
          throw new Error(`${method} is not available on a paired Orca server.`)
      }
    }
  }
}
