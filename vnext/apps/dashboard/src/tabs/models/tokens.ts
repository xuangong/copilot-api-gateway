// vnext/apps/dashboard/src/tabs/models/tokens.ts
/**
 * Token figures as the playground shows them.
 *
 * The context readout used to print only what the thread costs — "上下文:
 * 20836 tok" — which answers "how big is this" but not the question a user
 * actually has, which is "can I keep going". That needs the model's own
 * ceiling next to it, and a signal for when the gap is closing.
 */

/** `128000` → `128k`. Below 1k the exact figure is more informative than `0k`. */
export function formatTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/**
 * How close the thread is to the ceiling.
 *
 * `warn` is the point where a long reply might not fit; `full` is where the
 * next turn is likely to be refused outright. Both are advisory: the count is
 * of the prompt only, and the model still needs room to answer inside the same
 * window, so the true headroom is always smaller than the number shown.
 */
export type ContextPressure = 'ok' | 'warn' | 'full'

export const CONTEXT_WARN_RATIO = 0.75
export const CONTEXT_FULL_RATIO = 0.9

export function contextPressure(used: number, limit: number): ContextPressure {
  // A missing or nonsensical limit must not paint the readout red — an unknown
  // ceiling is not a full one.
  if (!(limit > 0)) return 'ok'
  const ratio = used / limit
  if (ratio >= CONTEXT_FULL_RATIO) return 'full'
  if (ratio >= CONTEXT_WARN_RATIO) return 'warn'
  return 'ok'
}

/** Whole percent, clamped so an over-limit thread reads `100%`, not `104%`. */
export function contextPercent(used: number, limit: number): number {
  if (!(limit > 0)) return 0
  return Math.min(100, Math.round((used / limit) * 100))
}
