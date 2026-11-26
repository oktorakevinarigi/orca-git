import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cliTerminalHost, matchServerWorkspace, serverWorkspaces, type ServerWorkspace } from './orcacli.ts'

const fe: ServerWorkspace = { environment: 'env-1', selector: 'identity:wt2:local:aaa', path: '/home/me/fe', displayName: 'main', branch: 'main', instanceId: 'aaa' }
const docs: ServerWorkspace = { environment: 'env-1', selector: 'identity:wt2:local:bbb', path: '/home/me/docs', displayName: 'main', branch: 'main', instanceId: 'bbb' }

test('a server workspace is matched by its identity instance, then by path, by name only when that is unique', () => {
  const list = [fe, docs]
  assert.equal(matchServerWorkspace(list, { workspaceId: 'identity:wt2:runtime:env-1:bbb', displayName: 'main', branch: 'main' }), docs)
  assert.equal(matchServerWorkspace(list, { path: '/home/me/fe/packages/ui' }), fe)
  assert.equal(matchServerWorkspace(list, { path: '/home/me/fe' }), fe)
  assert.equal(matchServerWorkspace(list, { path: '/home/me/fe-old' }), null)
  // Two workspaces share the name and branch: guessing would pick the wrong one.
  assert.equal(matchServerWorkspace(list, { workspaceId: 'identity:wt2:runtime:env-1:zzz', displayName: 'main', branch: 'refs/heads/main' }), null)
  assert.equal(matchServerWorkspace([fe], { workspaceId: 'identity:wt2:runtime:env-1:zzz', displayName: 'main', branch: 'refs/heads/main' }), fe)
})

test('server workspaces are listed from every saved server that answers', async () => {
  const cli = async (args: string[]) => {
    if (args.join(' ') === 'environment list') return { environments: [{ id: 'env-1' }, { id: 'offline' }] }
    if (args[3] === 'offline') throw new Error('remote_runtime_unavailable')
    return { worktrees: [{ id: 'r::/home/me/fe', displayName: 'main', path: '/home/me/fe', branch: 'refs/heads/main', identity: { key: 'wt2:local:aaa', instanceId: 'aaa' } }] }
  }
  assert.deepEqual(await serverWorkspaces(cli), [fe])
})

test('terminal calls become orca terminal commands on the server', async () => {
  const calls: string[][] = []
  const host = cliTerminalHost(async (args) => {
    calls.push(args)
    return args[1] === 'create' ? { terminal: { handle: 'term_1' } } : args[1] === 'read' ? { terminal: { tail: ['a', 'b'] } } : {}
  }, 'env-1')
  assert.deepEqual(await host.call('terminal.create', { workspaceId: 'identity:wt2:local:aaa', title: 'T', command: ' printf x' }), { terminalId: 'term_1' })
  assert.deepEqual(await host.call('terminal.sendText', { terminalId: 'term_1', text: 'ls', enter: true }), { accepted: true })
  assert.deepEqual(await host.call('terminal.read', { terminalId: 'term_1', maxLines: 2000 }), { lines: ['a', 'b'] })
  await host.call('terminal.close', { terminalId: 'term_1' })
  assert.deepEqual(calls, [
    ['terminal', 'create', '--environment', 'env-1', '--worktree', 'identity:wt2:local:aaa', '--title', 'T', '--command', ' printf x'],
    ['terminal', 'send', '--environment', 'env-1', '--terminal', 'term_1', '--text', 'ls', '--enter'],
    ['terminal', 'read', '--environment', 'env-1', '--terminal', 'term_1', '--limit', '2000'],
    ['terminal', 'close', '--environment', 'env-1', '--terminal', 'term_1']
  ])
  await assert.rejects(host.call('editor.open', {}), /not available/)
})
