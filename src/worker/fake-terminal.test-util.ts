// Test double for Orca's terminals on a remote host: a typed line runs in `sh` on this computer and
// its output is kept as lines; a read returns the newest lines within Orca's limits (2000 lines and
// a 32 KB budget), so the remote transport is tested end to end against a real repository.
import { spawnSync } from 'node:child_process'

export const READ_BUDGET = 32 * 1024

export interface FakeTerminals {
  /** Host method answers, for `mockHost({ results })` or a plain `TerminalHost`. */
  results: Record<string, (params: any) => unknown>
  call(method: string, params?: unknown): Promise<unknown>
  /** Output lines of every open terminal, by id. */
  open: Map<string, string[]>
  /** How many lines were typed in all. */
  typed(): number
}

export function fakeTerminals(options: { echo?: boolean } = {}): FakeTerminals {
  const open = new Map<string, string[]>()
  let next = 0
  let typedLines = 0
  const type = (id: string, text: string) => {
    const lines = open.get(id)!
    typedLines++
    // A shell echoes what is typed; long lines come back in fragments.
    if (options.echo !== false) lines.push(text.slice(0, 60), text.slice(-20))
    const result = spawnSync('sh', ['-c', text], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    lines.push(...`${result.stdout}${result.stderr}`.split('\n'), 'me@host repo %')
  }
  const missing = () => Object.assign(new Error('no live terminal has this id'), { code: 'action_failed' })
  const results: FakeTerminals['results'] = {
    'terminal.create': ({ command }: { command?: string }) => {
      const id = `term-${++next}`
      open.set(id, [])
      if (command) type(id, command)
      return { terminalId: id }
    },
    'terminal.sendText': ({ terminalId, text }: { terminalId: string; text: string }) => {
      if (!open.has(terminalId)) throw missing()
      type(terminalId, text)
      return { accepted: true }
    },
    'terminal.read': ({ terminalId, maxLines = 2000 }: { terminalId: string; maxLines?: number }) => {
      const lines = open.get(terminalId)
      if (!lines) throw missing()
      const tail: string[] = []
      let size = 0
      for (let i = lines.length - 1; i >= 0 && tail.length < Math.min(maxLines, 2000); i--) {
        if (size + lines[i].length > READ_BUDGET) break
        size += lines[i].length
        tail.unshift(lines[i])
      }
      return { lines: tail, truncated: tail.length < lines.length }
    },
    'terminal.close': ({ terminalId }: { terminalId: string }) => {
      open.delete(terminalId)
      return {}
    }
  }
  return {
    results,
    open,
    typed: () => typedLines,
    call: async (method, params) => {
      const answer = results[method]
      if (!answer) throw Object.assign(new Error(`unknown method ${method}`), { code: 'unknown_method' })
      return answer(params)
    }
  }
}
