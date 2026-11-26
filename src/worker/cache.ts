// Small in-memory caches for answers git gives again unchanged (a commit's parents, its diff).

/**
 * Remembers the promise of each key's answer, so a second ask, even while the first is still
 * running, shares it. Keeps the newest `max` keys; an entry expires `ttlMs` after it was made
 * (never, without one). A failed answer is forgotten at once, so the next ask tries again.
 */
export function createMemo<T>(max: number, ttlMs = Infinity) {
  const entries = new Map<string, { value: Promise<T>; at: number }>()
  return {
    get(key: string, compute: () => Promise<T>): Promise<T> {
      const now = Date.now()
      const known = entries.get(key)
      if (known && now - known.at < ttlMs) {
        // Refreshed as the newest.
        entries.delete(key)
        entries.set(key, known)
        return known.value
      }
      const value = compute()
      entries.delete(key)
      entries.set(key, { value, at: now })
      value.catch(() => {
        if (entries.get(key)?.value === value) entries.delete(key)
      })
      while (entries.size > max) entries.delete(entries.keys().next().value!)
      return value
    },
    clear: () => entries.clear()
  }
}
