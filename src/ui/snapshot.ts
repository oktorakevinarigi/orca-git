// Where a view of the log is saved. Orca runs the log in a sandboxed frame with no storage of its
// own, and can rebuild the frame when its tab comes back: the view is kept by the worker instead
// (`view.save` / `view.load`), with the commits, refs and details it was served.

/** The key of a view: the side panel has one, each Git Log tab one per repository. */
export const viewKey = (mode: 'panel' | 'editor', root?: string | null) => (mode === 'panel' ? 'panel' : `editor:${root ?? ''}`)

/** Selected commits saved at most: a frame may only send small messages (64 KB). */
export const MAX_SAVED_SELECTION = 500
