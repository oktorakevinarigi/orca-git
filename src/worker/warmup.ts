// What the panel asks for first when a repository opens: its HEAD, branches, status, uncommitted
// changes and first page of history. On a remote host each round trip costs about a second, so
// these are sent together with the repository lookup (RemoteShell.warm) and answered from there.
import { AHEAD_BEHIND_ARGS, HEAD_BRANCH_ARGS, HEAD_HASH_ARGS, logPageArgs, ME_ARGS, REFS_ARGS, UNCOMMITTED_ARGS, UNTRACKED_ARGS, UPSTREAM_ARGS, USERS_ARGS } from './log.ts'
import { OPERATION_FILES } from './rebase.ts'
import type { RemoteCall } from './remote.ts'

/** The calls the first view of the repository at `root` makes, with `pageSize` entries of history. */
export function firstViewCalls(root: string, pageSize: number): RemoteCall[] {
  const git = (args: string[]): RemoteCall => ({ kind: 'git', cwd: root, args })
  return [
    ...[HEAD_BRANCH_ARGS, HEAD_HASH_ARGS, REFS_ARGS, USERS_ARGS, ME_ARGS, UPSTREAM_ARGS, AHEAD_BEHIND_ARGS, UNCOMMITTED_ARGS, UNTRACKED_ARGS].map(git),
    git(logPageArgs({}, 0, pageSize)),
    ...OPERATION_FILES.map(([name]): RemoteCall => ({ kind: 'gitpath', cwd: root, name }))
  ]
}
