import { STRIP_WINDOW, type RollingStripCell } from "./usage-strip"

/**
 * What the budget box starts at. A round number rather than COST_ANCHOR_WINDOW:
 * the anchor is a *colour* scale, tuned so ordinary windows do not all render as
 * the same faint block, and borrowing it here would quietly imply the darkest
 * square is also the budget.
 */
export const DEFAULT_BUDGET_USD = 10000

/**
 * One reading of "suppose the current 28-day window opened `elapsed` days ago".
 */
export interface ForecastCandidate {
  /** Days of the window already spent, counting back from today inclusive. */
  elapsed: number
  /** The day such a window opened on, "YYYY-MM-DD". */
  startKey: string
  startLabel: string
  /** What those `elapsed` days actually cost — n(x). */
  spentUSD: number
  /** Days of the window still to come — the divisor, 28 - x. */
  remainingDays: number
  /** What each remaining day can cost, floored at zero. */
  dailyUSD: number
  /** The same figure unfloored; negative means the window is already blown. */
  rawDailyUSD: number
  overspent: boolean
}

/**
 * Rank the ways the current 28-day window could have started, cheapest future
 * first.
 *
 * The user knows they are somewhere inside a 28-day window but not where, so
 * every start day from today back to 27 days ago is a live hypothesis. Each one
 * implies a different answer to "what can I spend per day from here":
 *
 *     f(x) = (budget - n(x)) / (28 - x)
 *
 * where n(x) is the last x days added up. Note the divisor is the days that are
 * *left*, not the whole window — spreading the remainder over 28 would reduce
 * the ranking to "whichever run spent the most", which is always the longest one
 * and tells the user nothing.
 *
 * f is neither monotone nor unimodal in x: a longer run carries more spend but
 * also has fewer days to spread it over, and which effect wins depends on where
 * the busy days fell. So there is no shortcut past looking at all of them — but
 * one backward pass gives every n(x) for the cost of a single addition each, and
 * a bounded insertion keeps the three smallest without ever sorting. O(W).
 *
 * (There is an asymptotically better answer — each x is a *line* in the budget,
 * so the three cheapest are the bottom three levels of a line arrangement, which
 * a precomputed <=3-level answers in O(log W). It is not worth it here: that
 * table has to be rebuilt whenever n changes, and n changes on every filter and
 * every refresh — about as often as the budget does.)
 */
export function rankForecastCandidates(
  cells: RollingStripCell[],
  budgetUSD: number,
  top = 3,
  window: number = STRIP_WINDOW,
): ForecastCandidate[] {
  // An empty or cleared budget box is not a budget of nothing, it is no question
  // asked. NaN lands here too, which is what a half-typed "-" parses to.
  if (!(budgetUSD > 0)) return []
  // One short of the window: a run that has used all 28 days has no future left
  // to divide into. Capped by the history actually on the strip as well.
  const runs = Math.min(cells.length, window - 1)
  const want = Math.min(top, runs)
  if (want < 1) return []

  const best: ForecastCandidate[] = []
  let spent = 0
  for (let elapsed = 1; elapsed <= runs; elapsed++) {
    // Walking backwards from today turns n(x) into a running total: each step
    // adds exactly one day, so all 27 sums cost 27 additions rather than 27 sums.
    const cell = cells[cells.length - elapsed]!
    spent += cell.dayCostUSD
    const remainingDays = window - elapsed
    const rawDailyUSD = (budgetUSD - spent) / remainingDays

    // Ranked on the raw figure, shown floored. If the floor drove the order too,
    // every blown run would tie at zero and the three on screen would be
    // whichever three happened to be visited first.
    if (best.length === want && rawDailyUSD >= best[best.length - 1]!.rawDailyUSD) continue
    let at = best.length
    while (at > 0 && best[at - 1]!.rawDailyUSD > rawDailyUSD) at--
    best.splice(at, 0, {
      elapsed,
      startKey: cell.endKey,
      startLabel: cell.label,
      spentUSD: spent,
      remainingDays,
      dailyUSD: Math.max(0, rawDailyUSD),
      rawDailyUSD,
      overspent: rawDailyUSD < 0,
    })
    if (best.length > want) best.pop()
  }
  return best
}
