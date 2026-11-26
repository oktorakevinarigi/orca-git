// Test double for Orca's command line reaching a paired Orca server: an executable `orca` in a
// temporary folder that answers `--json` like the real one. Its server workspaces are given; a
// terminal's typed lines run in `sh` on this computer and reads return the newest lines within
// Orca's 32 KB budget, so the worker is tested end to end, from the CLI lookup to git.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface FakeServerWorkspace {
  id: string
  displayName: string
  path: string
  branch: string
  identity: { key: string; instanceId: string }
}

const SCRIPT = String.raw`
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
const state = process.env.FAKE_ORCA_STATE
const argv = process.argv.slice(2)
if (argv[0] === '--version') { console.log('fake-orca 1.0'); process.exit(0) }
appendFileSync(join(state, 'calls.jsonl'), JSON.stringify(argv) + '\n')
const words = [], flags = {}
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--json' || a === '--enter' || a === '--focus') flags[a.slice(2)] = true
  else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i]
  else words.push(a)
}
const fixture = JSON.parse(readFileSync(join(state, 'server.json'), 'utf8'))
const ok = (result) => { console.log(JSON.stringify({ id: 'x', ok: true, result })); process.exit(0) }
const fail = (message) => { console.log(JSON.stringify({ id: 'x', ok: false, error: { code: 'bad', message } })); process.exit(1) }
const log = (h) => join(state, h + '.log')
const type = (h, text) => {
  const r = spawnSync('sh', ['-c', text], { encoding: 'utf8', maxBuffer: 1 << 28 })
  appendFileSync(log(h), [text.slice(0, 60), ...(r.stdout + r.stderr).split('\n'), 'me@server %'].join('\n') + '\n')
}
const cmd = words.slice(0, 2).join(' ')
if (cmd === 'environment list') ok({ environments: [{ id: fixture.environment, name: 'server' }] })
if (cmd === 'worktree list') flags.environment === fixture.environment ? ok({ worktrees: fixture.worktrees }) : fail('unknown environment')
if (cmd === 'terminal create') {
  const n = (existsSync(join(state, 'n')) ? Number(readFileSync(join(state, 'n'), 'utf8')) : 0) + 1
  writeFileSync(join(state, 'n'), String(n))
  const h = 'term_' + n
  writeFileSync(log(h), '')
  if (flags.command) type(h, flags.command)
  ok({ terminal: { handle: h } })
}
if (cmd === 'terminal send') { if (!existsSync(log(flags.terminal))) fail('terminal_not_found'); type(flags.terminal, flags.text); ok({ send: {} }) }
if (cmd === 'terminal read') {
  if (!existsSync(log(flags.terminal))) fail('terminal_not_found')
  const lines = readFileSync(log(flags.terminal), 'utf8').split('\n')
  const tail = []
  let size = 0
  for (let i = lines.length - 1; i >= 0 && tail.length < Number(flags.limit ?? 120); i--) {
    if (size + lines[i].length > 32768) break
    size += lines[i].length
    tail.unshift(lines[i])
  }
  ok({ terminal: { handle: flags.terminal, status: 'running', tail } })
}
if (cmd === 'terminal close') { rmSync(log(flags.terminal), { force: true }); ok({ close: {} }) }
if (cmd === 'file open') { appendFileSync(join(state, 'opened.jsonl'), JSON.stringify({ worktree: flags.worktree, path: words[2] ?? flags.path }) + '\n'); ok({ opened: true }) }
fail('unknown command ' + cmd)
`

/** Writes the fake `orca` and points `ORCA_CLI_COMMAND` (the first place the worker looks) at it. */
export function installFakeOrcaCli(environment: string, worktrees: FakeServerWorkspace[]) {
  const state = mkdtempSync(join(tmpdir(), 'fake-orca-'))
  writeFileSync(join(state, 'server.json'), JSON.stringify({ environment, worktrees }))
  writeFileSync(join(state, 'fake-orca.mjs'), SCRIPT)
  const command = join(state, 'orca')
  writeFileSync(command, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(state, 'fake-orca.mjs'))} "$@"\n`)
  chmodSync(command, 0o755)
  process.env.ORCA_CLI_COMMAND = command
  process.env.FAKE_ORCA_STATE = state
  const lines = (file: string) => {
    try {
      return readFileSync(join(state, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
  return {
    state,
    /** Every command the worker ran, as its arguments. */
    calls: (): string[][] => lines('calls.jsonl'),
    /** Files opened with `orca file open`. */
    opened: (): { worktree: string; path: string }[] => lines('opened.jsonl')
  }
}
