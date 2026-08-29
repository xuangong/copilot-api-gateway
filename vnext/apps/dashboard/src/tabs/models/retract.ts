/**
 * Retracting a turn: drop one user message and everything that followed it.
 *
 * A typo or a misfired question doesn't just produce one bad answer — it stays
 * in the history and colours every turn after it. Clearing the whole thread is
 * the only existing escape, which throws away the good turns too. Retract cuts
 * the thread back to just before the mistake so the rest survives.
 */

/**
 * The thread as it stands just before the retracted message was sent.
 * Everything from `index` onward goes: the user turn itself, its reply, and
 * every turn built on top of them.
 */
export function retractFrom<M>(messages: M[], index: number): M[] {
  if (index < 0 || index >= messages.length) return messages
  return messages.slice(0, index)
}

/**
 * Per-message UI state keyed by message index (expanded source lists, the
 * "copied" flash) has to be cut to match, or the entries left behind land on
 * whatever message later takes that index.
 */
export function pruneIndexedState(indices: ReadonlySet<number>, cutAt: number): Set<number> {
  const next = new Set<number>()
  for (const i of indices) if (i < cutAt) next.add(i)
  return next
}
