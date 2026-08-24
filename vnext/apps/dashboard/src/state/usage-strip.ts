import type { UsageRangeQuery } from "../api/usage"
import { localDateKey } from "../components/TimeSeriesChart"

/**
 * How many squares the strip holds. Deliberately much longer than the 28-day
 * window itself: the strip's job is to show how the rolling total *moved*, and
 * 28 points of a 28-day average is barely a trend. 90 is about as many as a
 * full-width row can render at a size the eye can still separate.
 */
export const STRIP_CELLS = 90

/** How many days each square accumulates — the same window the chart draws. */
export const STRIP_WINDOW = 28

/**
 * The 28-day spend that reads as the darkest square. Chosen rather than derived:
 * an absolute scale means a colour keeps its meaning after the user changes a
 * filter, where GitHub's rank-against-the-busiest-cell scale would not. Stated
 * per window rather than per day so it is in the same unit as the square itself.
 */
export const COST_ANCHOR_WINDOW = 7000

/** What one day contributed, before any windowing. */
export interface DailyTotal {
  cost: number
  tokens: number
}

/** One square: the totals of the window that *closes* on `endKey`. */
export interface RollingStripCell {
  endKey: string
  label: string
  costUSD: number
  tokens: number
  /** What the closing day contributed by itself — the fill, not the outline. */
  dayCostUSD: number
  dayTokens: number
}

/**
 * The smallest fill a day with any spend at all gets. A day that cost $0.30
 * against a $400 peak is under a thousandth of the square, which draws as
 * nothing — and "nothing" already means "no usage", a different fact. Better to
 * overstate the smallest days than to lose them.
 */
export const MIN_DAY_FILL = 0.06

/**
 * How much of the square a single day's spend fills, 0 to 1.
 *
 * Relative where costShadeLevel is absolute, and deliberately so: the two answer
 * different questions. The outline says how big this window is on a fixed scale,
 * so its colour survives a change of filter; the fill says how big this day was
 * next to the busiest day on screen, which only has meaning against the days
 * actually drawn.
 */
export function dayFillRatio(dayCostUSD: number, peakDayCostUSD: number): number {
  if (!(peakDayCostUSD > 0) || !(dayCostUSD > 0)) return 0
  return Math.min(1, Math.max(MIN_DAY_FILL, dayCostUSD / peakDayCostUSD))
}

/**
 * Local midnight today — the day the strip always ends on, whatever window the
 * user has selected below it.
 */
export function stripLastDay(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
}

/** Local midnight `back` calendar days before `from`. */
function dayBefore(from: Date, back: number): Date {
  // Calendar days, not milliseconds: a DST shift makes a local day 23 or 25
  // hours long and would slide the result onto the wrong date.
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() - back, 0, 0, 0, 0)
}

/**
 * The query the strip needs, which is far wider than the window the summary
 * shows: the *earliest* square still looks a whole window behind itself, so the
 * fetch reaches back `cells + window - 2` days beyond the first closing day —
 * 117 days at the current settings.
 *
 * Deliberately a *separate* query from computeTimeRange rather than a widening
 * of it: the summary cards and the distribution tables sum every row they are
 * given, so feeding them the strip's history would silently triple the totals.
 *
 * Note what this does *not* take: the selected end date. The strip is a fixed
 * run of days ending today, and clicking a square must move only the selection
 * and the chart beneath it. Anchoring the span on the selection instead would
 * slide all ninety squares out from under the cursor on every click — and would
 * defeat the cache, since each click would ask for a span nobody had fetched.
 */
export function computeStripRange(
  now: Date = new Date(),
  cells: number = STRIP_CELLS,
  window: number = STRIP_WINDOW,
): UsageRangeQuery {
  const last = stripLastDay(now)
  const start = dayBefore(last, cells - 1 + (window - 1))
  // Runs to the current hour so today's partial usage counts toward the last
  // square, which is the one the eye goes to first.
  const end = new Date(now.getTime() + 3600000)
  return { start: start.toISOString().slice(0, 13), end: end.toISOString().slice(0, 13) }
}

/**
 * Turn per-day totals into one rolling-window total per closing day.
 *
 * `dailyTotals` is keyed by local date ("YYYY-MM-DD"); a day with no usage has
 * no entry and reads as zero rather than shortening the window.
 *
 * Genuinely a sliding sum: the span is walked once, each step adding the day
 * that entered the window and subtracting the day that left it, so the work is
 * O(cells + window) instead of the O(cells x window) a re-sum per square costs.
 */
export function buildRollingStrip(
  dailyTotals: Map<string, DailyTotal>,
  lastDay: Date,
  window: number = STRIP_WINDOW,
  cells: number = STRIP_CELLS,
): RollingStripCell[] {
  const span = cells + window - 1
  const first = dayBefore(lastDay, span - 1)

  // Materialise the span in order once, so the slide is plain array indexing
  // rather than a date-key lookup per (cell, day) pair.
  const days: Date[] = []
  const cost: number[] = []
  const tokens: number[] = []
  for (let i = 0; i < span; i++) {
    const d = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i, 0, 0, 0, 0)
    const v = dailyTotals.get(localDateKey(d))
    days.push(d)
    cost.push(v?.cost ?? 0)
    tokens.push(v?.tokens ?? 0)
  }

  const out: RollingStripCell[] = []
  let runCost = 0
  let runTokens = 0
  for (let i = 0; i < span; i++) {
    runCost += cost[i]!
    runTokens += tokens[i]!
    // Once the window is full, every further step drops its oldest day.
    if (i >= window) {
      runCost -= cost[i - window]!
      runTokens -= tokens[i - window]!
    }
    // The first `window - 1` positions have no full window behind them; they are
    // history for the squares, not squares themselves.
    if (i < window - 1) continue
    const close = days[i]!
    out.push({
      endKey: localDateKey(close),
      label: close.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      costUSD: runCost,
      tokens: runTokens,
      // Free: the closing day is the one just added to the running sum.
      dayCostUSD: cost[i]!,
      dayTokens: tokens[i]!,
    })
  }
  return out
}

/**
 * Which of the five shades a square's cost earns, 0 being empty.
 *
 * Quartered steps down from the anchor rather than an even split of it: spend
 * across a fleet of keys ranges over orders of magnitude, and a linear scale
 * pinned at the anchor would render every ordinary window as the same faint block.
 */
export function costShadeLevel(
  windowCostUSD: number,
  anchor: number = COST_ANCHOR_WINDOW,
): 0 | 1 | 2 | 3 | 4 {
  if (!(windowCostUSD > 0)) return 0
  if (windowCostUSD >= anchor) return 4
  if (windowCostUSD >= anchor / 4) return 3
  if (windowCostUSD >= anchor / 16) return 2
  return 1
}
