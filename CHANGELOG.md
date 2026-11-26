# Changelog

## 0.10.0 — 2026-11-26

Switching away from a Git Log tab and back no longer loads the log again: the tab shows the graph,
the selection, the scroll position, the opened commit and its details exactly as you left them, even
when Orca rebuilt the tab or you opened a changed file in its own tab meanwhile (a commit opened under
its row comes back open, at its place, without the log scrolling to it). Orca runs plugin views in
sandboxed frames that have no storage and may only send small messages, so the view is kept by the
plugin's worker, which hands back the commits, refs and details it served; the log reads git again
only when the repository changed meanwhile (a commit, checkout or fetch from a terminal still
refreshes it, in place, without a loading screen) or when you press Refresh or Fetch. The log no longer refreshes merely because it gets focus (a project on a
remote host, which cannot be watched, still does). The graph also appears sooner: the first page of
history now comes back with the repository lookup in one request instead of two, a folder's
repository and git's own file locations are looked up once, and the tab keeps its file out of
`git status` alongside the lookup instead of after it. A file's changes open faster too: the diff is
read while its tab is still opening, a commit's diff and parents are read from git only once
(opening the same file again is instant), a commit's details show at once when you select it again,
and the wait before reading the details of a selection is halved.

## 0.9.1 — 2026-11-26

When Git Log opens, the selected HEAD entry no longer opens its details under its row by itself: the
row opens when you click it, and a second click folds it again. A project on a paired Orca server now
opens about four times faster (about a second instead of five on a typical connection, and far less
than before 0.9.0). Every round trip to the server costs about a second, so the panel's first view
(HEAD, branches, status, uncommitted changes and the first page of history) now travels with the
repository lookup in a single trip and is answered from there, the details of an entry take one trip
instead of three, the check for a rebase or merge in progress takes none of its own, the server's
workspace is looked up once instead of on every refresh, and text is typed into the server's terminal
without the pause Orca adds before pressing Enter. The scripts sent to the host are compressed and
split so each typed line stays under Orca's 4096-character limit.

## 0.9.0 — 2026-11-26

Git Log opens in an Orca tab more easily, the way Git Control does: a **Git Log** button in the
status bar opens it, **Git Log** is in the tab bar + menu (an untitled tab shows the focused
repository), and the command is now **Git Log: Open in a Tab**. The tab's file is now named
`Git Log.gitlog`, so the tab reads "Git Log" instead of ".orca-git-log.gitlog" (the old file is
removed when the tab opens), and every `*.gitlog` file is kept out of `git status`, on this computer
and on a remote host alike.

## 0.8.0 — 2026-11-26

Git Log now opens the workspace that is actually focused, by its id, instead of guessing by name: a
project on a paired Orca server that also has a local copy with the same name and branch was read
from the local copy, so its diff tabs opened in a workspace the window was not showing. Orca's
plugin API does not reach a paired server's workspaces, so Git Log now reaches them with Orca's own
command line (`orca --environment`), which it finds by itself, and opens its helper terminal there.
Clicking a changed file opens its diff tab in the window, the "Open Git Log in an editor tab" button
works for remote projects too (both write their small file beside the project on that host), and a
tab the window cannot open for a plugin is opened with the command line instead. When a diff tab of
a remote project cannot open, the panel says why. A helper terminal that can no longer be typed into
is closed before a new one opens, and failures to open tabs are written to the plugin's log.

## 0.7.1 — 2026-11-25

Clicking a changed file of a project on a remote host now opens its diff in an editor tab, as it does
for a local project: Git Log writes the tab's small file in the project's `.orca-git-log` folder on
that host through its helper terminal (keeping that folder out of `git status`), and Orca opens it
from there. The Commit, Parents, Author, Committer and Date lines under an opened commit are no
longer drawn as boxes, and the opened area has its left and bottom border lines back.

## 0.7.0 — 2026-11-25

Projects on a remote host (a paired Orca server or an SSH host) now open in Git Log instead of being
refused. Orca gives plugins no direct access to a remote host, so Git Log opens one terminal there,
titled "Git Log (remote git)", types its git commands into it and reads the answers back: the commit
graph, branches, commit details, uncommitted changes and file diffs all load, and a changed file opens
in the editor from its row. On a remote host the log is read-only for now: actions that change the
repository (checkout, reset, squash, rebase, fetch, push and the others) are turned off with the
reason, diffs open inside the panel rather than in their own tab, and the panel refreshes when it gets
focus or on Refresh instead of watching files. The plugin now asks for permission to open, type into
and read its terminals. The details opened under a commit no longer have a border or underlined links.

## 0.6.0 — 2026-11-25

Selecting a single commit now opens its details right under its row in the log, like an accordion:
Commit, Parents (click one to jump to it), Author and Committer with their emails, the Date, and then
the whole commit message. The graph lanes carry on through the opened area, and selecting another
commit closes it and opens the new one; click the selected commit again to fold or unfold it. The
details pane on the right now shows only the files the commit changed. Text in the opened details can
be selected and copied with Ctrl+C.

## 0.5.0 — 2026-11-25

The "Uncommitted Changes" row can now be selected, by a click or with the arrow keys and Home. The
details pane then lists every changed file of the work tree against HEAD as a folder tree: staged and
unstaged edits, deletions, renames and untracked files (marked `?` and shown in green, one row per
file even inside a new folder). A click on a file opens its changes in a diff tab, from HEAD to the
working tree, with an untracked file shown as wholly added; the diff header names the sides "HEAD" and
"Working tree". A new "Open file" button, on each file row and in the diff header, opens the file
itself in an editor tab. The list follows the work tree while it is selected, and the row's count now
matches the number of files listed.

## 0.4.0 — 2026-11-25

The commit graph has a new look: thicker lines that bend in smooth curves where branches fork and
merge, a brighter palette of twelve lane colors, and a graph column of fixed width so every subject
starts at the same place. Branch and tag labels now sit in front of the subject as small boxes framed
in their branch's color, with the remotes that point at the same commit (`origin`) shown inside the
branch's label instead of as `origin & main`. Every commit is a solid dot and every row keeps its full
colors (commits not reachable from HEAD are no longer faded), and changed files in the details pane use
the usual Git colors: modified in yellow, added in green, deleted in red. Diff, banner and status colors
no longer change with the graph palette. A single click on a changed file now opens its diff (no more
double-click). When the work tree has uncommitted changes, an "Uncommitted Changes (N)" row appears
above the commits, with a dashed node and a dashed line down to the HEAD commit; it updates by itself
as files are edited, staged, committed or reverted. The diff panel has a new, slimmer header: icon
buttons for the previous and next change, the previous and next file ("2 of 5 files") and the whole
file, the number of differences, a side-by-side / unified switch, and a bar above each side naming its
revision and path; the changed lines keep their green and red backgrounds. Code in the diff is now
syntax-colored (keywords, types, strings, numbers, comments, function calls and properties) for
JavaScript, TypeScript, JSON, YAML, CSS, HTML/XML, Python, Go, Rust, Java, Kotlin, C, C#, Swift, PHP,
Ruby, shell and SQL files, and side by side the line numbers of both sides sit between them. A diff
now shows the whole file by default, scrolled to its first change; the expand button switches to only
the changed regions. A ruler on the right edge of the diff marks every change where it sits in the
file (green added, red removed, both for a changed block) and shades the part on screen; clicking a
mark goes to that change, and clicking or dragging on the ruler scrolls there. The Subject, Author,
Date and Hash columns of the log can be resized by dragging the borders between their headers (the
widths are remembered; double-click a border to go back to the default widths).

## 0.3.1 — 2026-11-16

The branches tree no longer shows the upstream next to each local branch (`→ origin/main`), so long
branch names fit; the upstream is still shown in the tooltip.

## 0.3.0 — 2026-11-16

The toolbar now shows the current branch with how far it is behind and ahead of its upstream, and any
rebase or merge in progress; new Fetch and Push buttons fetch every remote and push the current branch,
with a dialog that lists the commits to send, lets you choose the remote and remote branch (publishing a
new branch sets its upstream) and asks before a force push with lease. Right-clicking a branch can now
merge it into the current branch, rebase the current branch onto it, rename it or delete it (asking
again before deleting unmerged work). Checking out with uncommitted changes offers to stash them first.
Selecting several commits lists every file they change, and opening one shows the combined diff. Branch
names with slashes are grouped in folders, and opening a repository selects its HEAD commit.
## 0.2.0 — 2026-11-16

The branches tree is easier to use: a single click now shows only that branch's commits (click it again,
or Show all, to see every branch; Ctrl+click shows several), and a double-click or the locate button that
appears on hover jumps to its latest commit. The shown branches are clearly highlighted with a filter
mark, rows react on hover, and a line above the tree says which branches are shown. The Open in editor tab
button now sits to the right of Show details.

## 0.1.10 — 2026-11-16

No change to the panel itself: the project now has contribution guidelines (CONTRIBUTING.md, plus
AGENTS.md / CLAUDE.md for AI assistants) and a GitHub Action that requires every change to main to bump
the version and add a changelog entry, then tags and publishes the release automatically.

## 0.1.9 — 2026-11-16

Fixed the panel freezing (Orca reporting that Git Log stopped responding) when clicking or double-clicking
a branch in the branches tree. Jumping to a branch tip that was not loaded yet could spin forever while
another page or a branch filter was loading; it now waits for that load and gives up cleanly when the log
is reloaded, so double-clicking a branch reliably shows its log.

## 0.1.8 — 2026-11-16

The changed files of a commit now show as a folder tree: folders fold and unfold, chains of single-child
folders are joined on one line (`src/main/java/...`), each folder shows its file count, and Expand all /
Collapse all buttons sit next to the title; folded folders stay folded while you move between commits.
Double-clicking a changed file now opens its diff in its own Orca editor tab, one per file and commit,
with the same side-by-side / unified views and file navigation (Orca plugins cannot open separate
windows; the in-panel viewer remains as a fallback when no tab can open). The sidebar icon is now a Git
branch.

## 0.1.7 — 2026-11-10

WSL workspaces opened from Windows (`\\wsl.localhost\...`) now work: Git for Windows no longer refuses
them as "dubious ownership", since the plugin trusts those repositories for its own Git commands only.
Terminal titles showing WSL paths (`/home/me/repo` or `~/repo`) now identify the focused workspace, so
same-named workspaces are no longer reported as ambiguous, and the workspace picker shows clean paths.

## 0.1.6 — 2026-11-09

New cover image for the plugin page and the README, showing the plugin title and logo next to the
commit graph and its right-click menu.

## 0.1.5 — 2026-11-06

Adds **Create Patch…** to the commit menu: exports the selected commits with `git format-patch`, oldest
first, to a file or the clipboard. Every context-menu entry now has an icon, and the sidebar panel got
its own icon instead of reusing Source Control's.

## 0.1.4 — 2026-11-06

Adds a diff viewer: double-click (or press Enter on) a changed file in the details pane to see its
changes against the first parent, side by side or unified, with changed words highlighted, a Whole file
toggle, F7 / Shift+F7 to jump between changes and Alt+↑ / Alt+↓ to move between files. Also adds the
plugin icon, a cover image and refreshed screenshots.

## 0.1.3 — 2026-11-03

Screenshots of the log, the interactive rebase dialog and the light theme for the plugin page and the
README, with more neutral wording throughout.

## 0.1.2 — 2026-11-03

The panel now uses Orca's card surface as its background, matching Orca's own panels and tabs instead of
the darker app canvas.

## 0.1.1 — 2026-11-03

History rewriting is disabled, with the reason shown, for commits that cannot be rebased: commits brought
in by merges or older than a merge on HEAD's first-parent history. Previously these actions failed only
after being clicked (for example "commit is not part of the current branch").

## 0.1.0 — 2026-11-03

First release: a Git log in a sidebar panel and in an editor tab, with a coloured commit graph, branch and
tag labels, filters (text or hash, branch, user, date, paths), a Local / Remote / Tags branch tree and a
details pane. Multi-select commits and use the right-click menu to squash, fixup, drop, reword or
interactively rebase them, undo the last commit, check out, create branches and tags, cherry-pick, revert
or reset, with a warning before rewriting pushed commits and an Undo banner after each rewrite.
