// Git on a remote host (an SSH host or a paired Orca server), where this worker cannot run programs.
// Orca lets a plugin type into a terminal of the workspace and read the terminal's output, so the
// git calls made at about the same time are batched into one POSIX sh script that is typed there
// (base64, so any login shell takes it) and prints its results gzip+base64 between two markers.
// A terminal read returns at most ~32 KB, so a larger answer stays in a temporary folder on the
// host and is read in pieces.
import { randomBytes } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { GitError, lastLines, type Git, type GitOptions, type GitResult } from './git.ts'

/** What the transport needs from the worker's `orca.host`. */
export interface TerminalHost {
  call(method: string, params?: unknown): Promise<unknown>
}

export type RemoteCall =
  | { kind: 'git'; cwd: string; args: string[]; env?: Record<string, string> }
  /** Whether git's own file `name` (`--git-path`) exists in the repository at `cwd`. */
  | { kind: 'gitpath'; cwd: string; name: string }
  /** A short sh script run in `cwd` (with `g` for git), for the plugin's own files on the host. */
  | { kind: 'sh'; cwd: string; script: string }

/** Characters of packed output read per terminal read: under the host's 32 KB budget, with room for the prompt. */
export const CHUNK_CHARS = 30_000
const LINE_CHARS = 76
const BATCH_DELAY_MS = 8
const MAX_BATCH = 40
const MAX_PAYLOAD_CHARS = 48 * 1024 * 1024
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const TERMINAL_TITLE = 'Git Log (remote git)'
/** How long answers fetched ahead by `warm` are used instead of asking the host again. */
export const WARM_TTL_MS = 10_000

/** What makes two calls the same call, for answers fetched ahead; null for calls never fetched ahead. */
function callKey(call: RemoteCall): string | null {
  if (call.kind === 'git') return call.env ? null : JSON.stringify(['git', call.cwd, call.args])
  if (call.kind === 'gitpath') return JSON.stringify(['gitpath', call.cwd, call.name])
  return null
}

export const shellQuote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

const marker = (nonce: string, end: 'B' | 'E') => `GLB${nonce}${end}`
const workDir = (nonce: string) => `"\${TMPDIR:-/tmp}/orca-git-log-${nonce}"`

/** The script that runs `calls` and prints, between markers, how big the packed results are and their first piece (all of them when small). */
export function batchScript(calls: RemoteCall[], nonce: string): string {
  const lines = [
    `d=${workDir(nonce)}`,
    'rm -rf "$d"; mkdir -p "$d" || exit 1',
    'g() { GIT_TERMINAL_PROMPT=0 LC_ALL=C git -c core.quotepath=off -c color.ui=false -c log.showSignature=false "$@" </dev/null; }'
  ]
  calls.forEach((call, i) => {
    const files = `>"$d/${i}o" 2>"$d/${i}e"`
    if (call.kind === 'gitpath') {
      lines.push(`{ p=$(cd ${shellQuote(call.cwd)} && g rev-parse --path-format=absolute --git-path ${shellQuote(call.name)}) && [ -e "$p" ]; } ${files}; echo $? >"$d/${i}c"`)
      return
    }
    if (call.kind === 'sh') {
      lines.push(`(cd ${shellQuote(call.cwd)} && ${call.script}) ${files}; echo $? >"$d/${i}c"`)
      return
    }
    const env = Object.entries(call.env ?? {})
      .filter(([name]) => ENV_NAME.test(name))
      .map(([name, value]) => `export ${name}=${shellQuote(value)}; `)
      .join('')
    lines.push(`(cd ${shellQuote(call.cwd)} && ${env}g ${call.args.map(shellQuote).join(' ')}) ${files}; echo $? >"$d/${i}c"`)
  })
  const all = calls.map((_, i) => i).join(' ')
  lines.push(
    `{ for i in ${all}; do printf '%s %s %s\\n' "$(cat "$d/$i"c)" $(wc -c <"$d/$i"o) $(wc -c <"$d/$i"e); done; for i in ${all}; do cat "$d/$i"o "$d/$i"e; done; } | gzip -9c | base64 | tr -d '\\n' >"$d/p"`,
    'n=$(wc -c <"$d/p" | tr -d " ")',
    `echo; printf '%s %s\\n' ${marker(nonce, 'B')} "$n"`,
    // The first piece comes with the answer: a larger one needs only the rest read after it.
    `cut -c 1-${CHUNK_CHARS} "$d/p" | fold -w ${LINE_CHARS}; echo`,
    `if [ "$n" -le ${CHUNK_CHARS} ]; then rm -rf "$d"; fi`,
    `echo ${marker(nonce, 'E')}`
  )
  return lines.join('\n')
}

/** Prints characters `from`..`to` (1-based) of a batch's packed results; the last piece removes its folder. */
export function chunkScript(batchNonce: string, nonce: string, from: number, to: number, last: boolean): string {
  return [
    `d=${workDir(batchNonce)}`,
    `echo; echo ${marker(nonce, 'B')}`,
    `cut -c ${from}-${to} "$d/p" | fold -w ${LINE_CHARS}; echo`,
    ...(last ? ['rm -rf "$d"'] : []),
    `echo ${marker(nonce, 'E')}`
  ].join('\n')
}

/** What one terminal line types: the script as base64, so no login shell (bash, zsh, fish) parses it. The leading space keeps it out of shell history. */
export const typedLine = (script: string) => ` printf %s ${gzipSync(Buffer.from(script, 'utf8')).toString('base64')} | base64 -d | gzip -dc | sh`

/** Longest line Orca lets a plugin type into a terminal (4096 characters), with room to spare. */
export const MAX_TYPED_CHARS = 4000

/** The answer between the markers of `nonce`, once its end marker has been printed; null before. */
export function readAnswer(lines: string[], nonce: string): { size: number | null; text: string } | null {
  const lastIndex = (match: (line: string) => boolean, before = lines.length) => {
    for (let i = before - 1; i >= 0; i--) if (match(lines[i].trim())) return i
    return -1
  }
  const end = lastIndex((line) => line === marker(nonce, 'E'))
  if (end < 0) return null
  const begin = lastIndex((line) => line.startsWith(marker(nonce, 'B')), end)
  if (begin < 0) throw new Error('The answer from the remote host was cut short.')
  const size = lines[begin].trim().split(/\s+/)[1]
  return { size: size === undefined ? null : Number(size), text: lines.slice(begin + 1, end).join('').replace(/\s+/g, '') }
}

/** Splits the packed results of `count` calls (header lines `code out-bytes err-bytes`, then the bodies). */
export function unpackResults(packed: string, count: number): GitResult[] {
  const data = gunzipSync(Buffer.from(packed, 'base64'))
  let at = 0
  const headers: number[][] = []
  for (let i = 0; i < count; i++) {
    const newline = data.indexOf(10, at)
    if (newline < 0) throw new Error('The answer from the remote host is incomplete.')
    headers.push(data.subarray(at, newline).toString('utf8').trim().split(/\s+/).map(Number))
    at = newline + 1
  }
  return headers.map(([code, outBytes, errBytes]) => {
    const stdout = data.subarray(at, (at += outBytes)).toString('utf8')
    const stderr = data.subarray(at, (at += errBytes)).toString('utf8')
    return { ok: code === 0, code: Number.isFinite(code) ? code : null, stdout, stderr }
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const hex = () => randomBytes(6).toString('hex')

type Pending = { call: RemoteCall; resolve(result: GitResult): void; reject(error: unknown): void }

/** One workspace's helper terminal: calls are batched, and batches run one after another. */
export class RemoteShell {
  private terminalId: string | null = null
  private queue: Pending[] = []
  private scheduled = false
  private chain: Promise<void> = Promise.resolve()
  private readonly host: TerminalHost
  private readonly timing: { pollMs: number; timeoutMs: number }
  /** Answers fetched ahead (`warm`), by call, while still in flight too. */
  private warmed = new Map<string, { answer: Promise<GitResult>; until: number }>()
  readonly workspaceId: string

  constructor(host: TerminalHost, workspaceId: string, timing = { pollMs: 120, timeoutMs: 90_000 }) {
    this.host = host
    this.workspaceId = workspaceId
    this.timing = timing
  }

  run(call: RemoteCall): Promise<GitResult> {
    const key = callKey(call)
    const warm = key ? this.warmed.get(key) : undefined
    if (warm && warm.until > Date.now()) return warm.answer
    return new Promise((resolve, reject) => {
      this.queue.push({ call, resolve, reject })
      this.schedule()
    })
  }

  /**
   * Sends `calls` with the next batch and keeps their answers for a few seconds: the same calls
   * made meanwhile (or still waiting for this batch) need no round trip of their own. Answers
   * fetched ahead earlier are dropped first, so a refresh always reads afresh.
   */
  warm(calls: RemoteCall[], ttlMs = WARM_TTL_MS): void {
    this.warmed.clear()
    for (const call of calls) {
      const key = callKey(call)
      if (!key || this.warmed.has(key)) continue
      const answer = new Promise<GitResult>((resolve, reject) => {
        this.queue.push({ call, resolve, reject })
        this.schedule()
      })
      const entry = { answer, until: Date.now() + ttlMs }
      this.warmed.set(key, entry)
      answer.catch(() => this.warmed.get(key) === entry && this.warmed.delete(key))
    }
  }

  async close(): Promise<void> {
    const id = this.terminalId
    this.terminalId = null
    if (id) await this.host.call('terminal.close', { terminalId: id }).catch(() => undefined)
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    setTimeout(() => {
      this.chain = this.chain.then(() => this.drain())
    }, BATCH_DELAY_MS)
  }

  private async drain(): Promise<void> {
    this.scheduled = false
    // As many calls as one typed line holds; the rest go in the next batch.
    const batch: Pending[] = []
    while (this.queue.length && batch.length < MAX_BATCH) {
      const next = [...batch, this.queue[0]].map((p) => p.call)
      if (batch.length && typedLine(batchScript(next, '0'.repeat(12))).length > MAX_TYPED_CHARS) break
      batch.push(this.queue.shift()!)
    }
    if (this.queue.length) this.schedule()
    if (!batch.length) return
    try {
      const results = await this.execute(batch.map((p) => p.call))
      batch.forEach((p, i) => p.resolve(results[i]))
    } catch (error) {
      batch.forEach((p) => p.reject(error))
    }
  }

  private async execute(calls: RemoteCall[]): Promise<GitResult[]> {
    const nonce = hex()
    const first = await this.exchange(batchScript(calls, nonce), nonce)
    const size = first.size ?? -1
    if (!(size > 0 && size <= MAX_PAYLOAD_CHARS)) throw new Error('The remote host sent no usable answer (it needs sh, git, gzip and base64).')
    let packed = first.text
    if (size > CHUNK_CHARS) {
      const parts: string[] = [first.text]
      for (let from = CHUNK_CHARS + 1; from <= size; from += CHUNK_CHARS) {
        const to = Math.min(size, from + CHUNK_CHARS - 1)
        const piece = hex()
        parts.push((await this.exchange(chunkScript(nonce, piece, from, to, to === size), piece)).text)
      }
      packed = parts.join('')
    }
    if (packed.length !== size) throw new Error('The answer from the remote host arrived incomplete.')
    return unpackResults(packed, calls.length)
  }

  /** Types `script` into the helper terminal and waits for its answer. */
  private async exchange(script: string, nonce: string): Promise<{ size: number | null; text: string }> {
    await this.type(typedLine(script))
    const deadline = Date.now() + this.timing.timeoutMs
    let wait = this.timing.pollMs
    while (Date.now() < deadline) {
      await sleep(wait)
      wait = Math.min(wait * 1.5, 1000)
      const { lines } = (await this.host.call('terminal.read', { terminalId: this.terminalId, maxLines: 2000 })) as { lines: string[] }
      const answer = readAnswer(lines ?? [], nonce)
      if (answer) return answer
    }
    throw new Error('The remote host did not answer in time.')
  }

  /** Types a line, opening the helper terminal first (again, when the person closed it). */
  private async type(line: string): Promise<void> {
    if (this.terminalId) {
      try {
        await this.host.call('terminal.sendText', { terminalId: this.terminalId, text: line, enter: true })
        return
      } catch {
        // Gone, or Orca only lets a plugin type into the focused workspace: a fresh terminal runs
        // the line as its startup command, and the old one is closed so none pile up.
        const stale = this.terminalId
        this.terminalId = null
        await this.host.call('terminal.close', { terminalId: stale }).catch(() => undefined)
      }
    }
    const created = (await this.host.call('terminal.create', { workspaceId: this.workspaceId, title: TERMINAL_TITLE, command: line })) as { terminalId: string }
    this.terminalId = created.terminalId
  }
}

/** A Git runner for the repository at `root` on the shell's host. */
export function createRemoteGit(shell: RemoteShell, root: string): Git {
  const run = (args: string[], options: GitOptions = {}) => shell.run({ kind: 'git', cwd: root, args, ...(options.env ? { env: options.env } : {}) })
  return {
    remote: true,
    run,
    async out(args, options) {
      const result = await run(args, options)
      if (!result.ok) throw new GitError(lastLines(result.stderr || result.stdout) || `git ${args[0]} failed`, result)
      return result.stdout
    },
    gitPathsExist: (names) => Promise.all(names.map((name) => shell.run({ kind: 'gitpath', cwd: root, name }).then((result) => result.ok)))
  }
}
