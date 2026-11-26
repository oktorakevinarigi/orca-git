// Entry of a diff editor tab: its document names the commit and files to show.
import type { DiffTabRequest } from '../shared/protocol.ts'
import { errorMessage, orca } from './api.ts'
import { DIFF_TAB_PREFS_KEY, openDiff, readDiffTabPrefs } from './diff.ts'
import { h } from './dom.ts'

async function start(): Promise<void> {
  let req: DiffTabRequest
  try {
    const doc = await orca.document!.get()
    req = JSON.parse(doc.content.text ?? '')
    if (!req?.root || !req.hash || !Array.isArray(req.files) || !req.files.length) throw new Error('This diff file is incomplete.')
  } catch (error) {
    document.body.append(h('div', { class: 'diff-note error' }, `Cannot show this diff: ${errorMessage(error)}`))
    return
  }
  const prefs = readDiffTabPrefs()
  openDiff({
    root: req.root,
    hash: req.hash,
    files: req.files,
    index: req.index,
    mode: prefs.mode,
    wholeFile: !prefs.changesOnly,
    embedded: true,
    onPrefs: (mode, wholeFile) => {
      try {
        localStorage.setItem(DIFF_TAB_PREFS_KEY, JSON.stringify({ mode, changesOnly: !wholeFile }))
      } catch {
        // Orca's sandboxed frames may have no storage: the layout lasts while the tab is open.
      }
    }
  })
}

void start()
