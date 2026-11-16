type Listener = () => void
const listeners = new Set<Listener>()

/** Registers a callback for "configuration was just imported". Returns the unsubscribe function. */
export function onConfigurationImported(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Called by the import route. A throwing listener never affects the import. */
export function notifyConfigurationImported(): void {
  for (const listener of listeners) {
    try { listener() } catch { /* Advisory. */ }
  }
}
