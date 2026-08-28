// vnext/apps/dashboard/src/tabs/models/scroll.ts
/**
 * Stick-to-bottom bookkeeping for the playground thread.
 *
 * The thread used to smooth-scroll to the bottom on every `messages` change.
 * During a stream that fires once per delta, so a smooth animation was
 * perpetually restarted toward a target that kept moving — the visible jitter —
 * and it also yanked back anyone who had scrolled up to read.
 *
 * The rule this encodes instead: only follow the bottom if the reader was
 * already at the bottom. When they are not, doing nothing is the correct
 * behaviour — the browser's own scroll anchoring keeps the viewport steady
 * while content grows below the fold, but only as long as nothing scrolls
 * programmatically.
 */

/**
 * Sub-pixel slack. `scrollHeight`/`clientHeight` are integers while
 * `scrollTop` is fractional under a non-integer device pixel ratio, so an exact
 * comparison never holds and the thread would silently stop following. The
 * threshold is also deliberately larger than that: a reader a line or two off
 * the bottom still means "following along".
 */
export const STICK_TO_BOTTOM_SLACK_PX = 32

export type ScrollMetrics = Pick<Element, 'scrollTop' | 'scrollHeight' | 'clientHeight'>

export function distanceFromBottom(el: ScrollMetrics): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}

export function isAtBottom(el: ScrollMetrics, slack = STICK_TO_BOTTOM_SLACK_PX): boolean {
  return distanceFromBottom(el) <= slack
}
