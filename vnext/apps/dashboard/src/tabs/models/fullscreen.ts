/**
 * Whether the playground opens fullscreen.
 *
 * The rule is deliberately asymmetric, because the two ways of arriving here
 * mean different things:
 *
 *   * Reloading the page, or opening `#models` directly, is *resuming*. The
 *     workbench should come back the way it was left — including fullscreen.
 *   * Clicking over from another tab is *navigating*. Slamming an overlay over
 *     the whole dashboard because of something the user did in an earlier
 *     session would be a jump scare, not a convenience; they came from a page
 *     they could see, and the panel should stay in that same frame.
 *
 * "Resuming" is a property of the page load, not of the component — a single
 * load can mount this tab many times as the user moves around. So the flag is
 * read once at module scope and spent on the first mount (see `takeLanded`).
 */

const LS_FULLSCREEN = "playground.fullscreen"

/** The tab id this panel lives under in the hash router. */
const PLAYGROUND_HASH = "models"

/**
 * Pure core, so the decision can be tested without a `location` or a
 * `localStorage`. `landed` is whether this page load started on the
 * playground; `stored` is the persisted flag as read from storage.
 */
export function shouldRestoreFullscreen(landed: boolean, stored: string | null): boolean {
  return landed && stored === "1"
}

/**
 * True if the *initial* URL of this page load pointed at the playground.
 * Captured at module evaluation — i.e. once per load, before any navigation —
 * so later hash changes can't make a tab switch look like a fresh landing.
 */
const initialHashWasPlayground =
  typeof window !== "undefined" &&
  window.location.hash.replace(/^#/, "") === PLAYGROUND_HASH

let landedUnspent = initialHashWasPlayground

/** Spend the landing. Call once the first mount has had its chance to read it. */
export function spendLanded(): void {
  landedUnspent = false
}

export function initialFullscreen(): boolean {
  try {
    return shouldRestoreFullscreen(landedUnspent, localStorage.getItem(LS_FULLSCREEN))
  } catch {
    // Storage can throw outright in a locked-down browser; not being fullscreen
    // is the safe answer, since every other control stays reachable.
    return false
  }
}

export function persistFullscreen(on: boolean): void {
  try {
    localStorage.setItem(LS_FULLSCREEN, on ? "1" : "0")
  } catch {
    /* nothing to do — the preference just won't survive the reload */
  }
}
