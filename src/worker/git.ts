import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface GitResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
}

export interface GitOptions {
  env?: Record<string, string>
  timeoutMs?: number
}

export interface Git {
  run(args: string[], options?: GitOptions): Promise<GitResult>
  /** Runs and returns stdout, throwing a readable Error when git fails. */
  out(args: string[], options?: GitOptions): Promise<string>
  /** Whether each of git's own files (`--git-path`, such as MERGE_HEAD) exists, wherever the repository lives. */
  gitPathsExist(names: string[]): Promise<boolean[]>
  /** Where git runs: on this computer, or on a remote host through a terminal (read-only there). */
  readonly remote?: boolean
}

export class GitError extends Error {
  constructor(message: string, readonly result: GitResult) {
    super(message)
  }
}

export function lastLines(text: string, count = 6): string {
  return text.trim().split(/\r?\n/).slice(-count).join('\n')
}

/** `\\wsl.localhost\<distro>\...` or `\\wsl$\<distro>\...`, a WSL file system seen from Windows. */
export const isWslPath = (path: string) => /^[\\/]{2}wsl(\.localhost|\$)[\\/]/i.test(path)

export function createGit(root: string, gitPath = 'git'): Git {
  // Git for Windows sees WSL files as owned by someone else and refuses them ("dubious ownership").
  // Set through the environment so git processes started by git itself (rebase exec) inherit it.
  const trust = isWslPath(root) ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*' } : {}
  const run = (args: string[], options: GitOptions = {}) =>
    new Promise<GitResult>((resolve) => {
      execFile(
        gitPath,
        ['-c', 'core.quotepath=off', '-c', 'color.ui=false', '-c', 'log.showSignature=false', ...args],
        {
          cwd: root,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...trust, ...options.env },
          maxBuffer: 64 * 1024 * 1024,
          timeout: options.timeoutMs ?? 60_000,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          const code = error ? (typeof (error as any).code === 'number' ? (error as any).code : null) : 0
          resolve({ ok: !error, code, stdout: String(stdout), stderr: String(stderr || (error && !stderr ? error.message : '')) })
        }
      )
    })
  // Where git keeps its own files does not move: asked once per set of names, then checked on disk.
  const gitPaths = new Map<string, Promise<string[] | null>>()
  const locate = (names: string[]) => {
    const key = names.join('\0')
    let found = gitPaths.get(key)
    if (!found) {
      found = run(['rev-parse', '--path-format=absolute', ...names.flatMap((name) => ['--git-path', name])]).then((result) =>
        result.ok ? result.stdout.split(/\r?\n/).map((path) => path.trim()) : null
      )
      gitPaths.set(key, found)
      // A failed lookup (a repository being created) is asked again next time.
      void found.then((paths) => paths ?? gitPaths.delete(key))
    }
    return found
  }
  return {
    run,
    async out(args, options) {
      const result = await run(args, options)
      if (!result.ok) throw new GitError(lastLines(result.stderr || result.stdout) || `git ${args[0]} failed`, result)
      return result.stdout
    },
    async gitPathsExist(names) {
      if (!names.length) return []
      const paths = (await locate(names)) ?? []
      return names.map((_, i) => Boolean(paths[i]) && existsSync(paths[i]))
    }
  }
}
