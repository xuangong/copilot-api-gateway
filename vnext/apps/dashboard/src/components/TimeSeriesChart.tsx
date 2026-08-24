import { useEffect, useRef, useState } from "react"
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Legend,
  Filler,
  type ChartDataset as CJDataset,
  type TooltipModel,
} from "chart.js"

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
  Legend,
  Filler,
)

const PALETTE_LIGHT = ["#4E6CF5","#2CA87A","#D88A2E","#8058C8","#C85878","#1E98A0","#9B60B8","#2E9080","#5078C0","#5A9850"]
const PALETTE_DARK  = ["#7B90FF","#50D48A","#F0B050","#A880F0","#F07898","#50C5D0","#C098E0","#58CCB0","#7098E0","#90C880"]

export function paletteFor(theme: "dark" | "light"): string[] {
  return theme === "dark" ? PALETTE_DARK : PALETTE_LIGHT
}

export interface ChartDataset {
  label: string
  data: number[]
  color: string
  dashed?: boolean
  fill?: boolean
}

export interface ChartPointLink {
  /**
   * Link text for the hovered point, or null to omit the link — an empty
   * bucket has nothing worth opening.
   */
  labelFor: (index: number) => string | null
  /** Called with the hovered point's index when the link is clicked. */
  onSelect: (index: number) => void
}

interface Props {
  labels: string[]
  datasets: ChartDataset[]
  height?: number
  unitLabel?: string
  yTickFormat?: (v: number) => string
  /**
   * Renders the tooltip in the DOM instead of on the canvas so it can hold a
   * real, clickable link. Chart.js draws its built-in tooltip into the canvas,
   * where nothing is clickable.
   */
  pointLink?: ChartPointLink
}

function isDarkTheme(): boolean {
  if (typeof document === "undefined") return true
  return document.documentElement.getAttribute("data-theme") === "dark"
}

function cssVar(name: string): string {
  if (typeof document === "undefined") return ""
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function defaultYTick(v: number): string {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M"
  if (v >= 1e3) return (v / 1e3).toFixed(0) + "K"
  return String(v)
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "")
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h
  const n = parseInt(full, 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * Chart.js-backed time-series chart. Bundled — no CDN.
 * Dark-mode aware via `theme-changed` window event.
 */
export function TimeSeriesChart({ labels, datasets, height = 300, unitLabel = "", yTickFormat, pointLink }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const chartRef = useRef<Chart | null>(null)
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const overTip = useRef(false)
  const linkRef = useRef<LinkState | null>(null)
  linkRef.current = pointLink ? { index: linkRef.current?.index ?? 0, link: pointLink } : null
  const [themeTick, setThemeTick] = useState(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    if (chartRef.current) {
      chartRef.current.destroy()
      chartRef.current = null
    }

    const dark = isDarkTheme()
    const gridC = cssVar("--grid-color") || (dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)")
    const tickC = cssVar("--tick-color") || (dark ? "#9ca3af" : "#4b5563")
    const tickFmt = yTickFormat ?? defaultYTick
    const fillAlpha = dark ? 0.12 : 0.18

    const cjDatasets: CJDataset<"line", number[]>[] = datasets.map((d) => ({
      label: d.label,
      data: d.data,
      borderColor: d.color,
      backgroundColor: d.fill === false ? "transparent" : hexToRgba(d.color, fillAlpha),
      borderWidth: d.dashed ? 1.5 : 2,
      borderDash: d.dashed ? [4, 4] : undefined,
      fill: d.fill !== false,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.25,
    }))

    chartRef.current = new Chart(canvas, {
      type: "line",
      data: { labels, datasets: cjDatasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            display: true,
            labels: { color: tickC, font: { family: "Outfit, sans-serif", size: 11 } },
          },
          tooltip: pointLink
            ? { enabled: false, external: (ctx) => renderLinkTooltip(ctx, tooltipRef.current, unitLabel, linkRef, hideTimer, overTip) }
            : {
                callbacks: {
                  label: (c) => `${c.dataset.label}: ${Number(c.parsed.y).toLocaleString()}${unitLabel}`,
                },
              },
        },
        scales: {
          x: {
            ticks: { color: tickC, font: { family: "Outfit, sans-serif", size: 10 } },
            grid: { display: false },
          },
          y: {
            ticks: { color: tickC, font: { family: "IBM Plex Mono, monospace", size: 10 }, callback: (v) => tickFmt(Number(v)) },
            grid: { color: gridC },
          },
        },
      },
    })

    return () => {
      if (chartRef.current) {
        chartRef.current.destroy()
        chartRef.current = null
      }
    }
  }, [labels, datasets, height, unitLabel, yTickFormat, themeTick, pointLink])

  useEffect(() => {
    const handler = () => setThemeTick((n) => n + 1)
    window.addEventListener("theme-changed", handler)
    return () => window.removeEventListener("theme-changed", handler)
  }, [])

  // Hovering the tooltip cancels the pending hide so its link stays reachable;
  // leaving it hides at once.
  useEffect(() => {
    const el = tooltipRef.current
    if (!el) return
    // Tracked as state rather than by cancelling the pending timer: Chart.js
    // runs its external handler asynchronously after the canvas mouseout, so
    // the enter often arrives *before* there is any timer to cancel.
    const cancel = () => {
      overTip.current = true
      if (hideTimer.current !== null) {
        clearTimeout(hideTimer.current)
        hideTimer.current = null
      }
    }
    const leave = () => {
      overTip.current = false
      hideTooltip(el)
    }
    el.addEventListener("mouseenter", cancel)
    el.addEventListener("mouseover", cancel)
    el.addEventListener("mouseleave", leave)
    return () => {
      el.removeEventListener("mouseenter", cancel)
      el.removeEventListener("mouseover", cancel)
      el.removeEventListener("mouseleave", leave)
    }
  }, [pointLink])

  return (
    <div style={{ height, width: "100%", position: "relative" }}>
      <canvas ref={canvasRef} />
      {pointLink ? (
        <div ref={tooltipRef} className="pg-chart-tip" />
      ) : null}
    </div>
  )
}

// — DOM tooltip with a clickable link —
//
// Chart.js paints its tooltip onto the canvas, so a link inside it could never
// be clicked. `external` hands us the model and lets us draw it ourselves.

interface LinkState {
  index: number
  link: ChartPointLink
}

/**
 * Where to put the tooltip box for a point at (anchorX, anchorY).
 *
 * Anchored to the data point rather than the cursor: a tooltip that tracks the
 * caret slides away from the pointer that is trying to reach its link. Being a
 * pure function of the anchor, it also means vertical mouse movement — exactly
 * the movement you make to reach the box — never shifts it at all.
 */
export function tooltipPlacement({
  anchorX,
  anchorY,
  tip,
  canvas,
  gap,
}: {
  anchorX: number
  anchorY: number
  tip: { width: number; height: number }
  canvas: { width: number; height: number }
  gap: number
}): { left: number; top: number; below: boolean } {
  const below = anchorY - tip.height - gap < 0
  const top = below ? anchorY + gap : anchorY - tip.height - gap
  const maxLeft = Math.max(0, canvas.width - tip.width)
  return {
    left: Math.min(maxLeft, Math.max(0, anchorX - tip.width / 2)),
    top: Math.max(0, top),
    below,
  }
}

export interface TooltipRow {
  label: string
  value: number
  color: string
}

/**
 * A bucket usually has one active series and several sitting at zero — the
 * "Cache" line especially. Listing them buries the number you hovered for.
 *
 * Non-zero rather than positive: these charts do not produce negative values,
 * but if one ever appeared it would be real data, not noise.
 */
export function visibleTooltipRows(rows: TooltipRow[]): TooltipRow[] {
  return rows.filter((r) => r.value !== 0)
}

function hideTooltip(el: HTMLDivElement | null) {
  if (el) el.style.opacity = "0"
  if (el) el.style.pointerEvents = "none"
}

function renderLinkTooltip(
  ctx: { chart: Chart; tooltip: TooltipModel<"line"> },
  el: HTMLDivElement | null,
  unitLabel: string,
  linkRef: { current: LinkState | null },
  hideTimer: { current: ReturnType<typeof setTimeout> | null },
  overTip: { current: boolean },
) {
  if (!el || !linkRef.current) return
  const { chart, tooltip } = ctx

  if (tooltip.opacity === 0) {
    // Already inside the tooltip — leaving the canvas is exactly what moving
    // toward it looks like, so this must not hide anything.
    if (overTip.current) return
    // Otherwise give the pointer a moment to cross the gap.
    if (hideTimer.current !== null) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      if (!overTip.current) hideTooltip(el)
    }, 220)
    return
  }
  if (hideTimer.current !== null) { clearTimeout(hideTimer.current); hideTimer.current = null }

  const index = tooltip.dataPoints[0]?.dataIndex ?? 0
  const sameBucket = linkRef.current.index === index && el.style.opacity === "1"
  linkRef.current = { ...linkRef.current, index }
  // Only the bucket matters. Re-rendering on every mousemove within one bucket
  // would rewrite the DOM under the pointer and cancel a click in progress.
  if (sameBucket) return

  const title = tooltip.title[0] ?? ""
  const rows = visibleTooltipRows(
    tooltip.dataPoints.map((p) => ({
      label: String(p.dataset.label ?? ""),
      value: Number(p.parsed.y),
      color: String(p.dataset.borderColor ?? ""),
    })),
  )
    .map((r) => `<div class="pg-chart-tip-row"><span class="pg-chart-tip-dot" style="background:${escapeHtml(r.color)}"></span>${escapeHtml(r.label)}<b>${r.value.toLocaleString()}${escapeHtml(unitLabel)}</b></div>`)
    .join("")
  const linkLabel = linkRef.current.link.labelFor(index)
  const linkHtml = linkLabel === null
    ? ""
    : `<button type="button" class="pg-chart-tip-link">${escapeHtml(linkLabel)}</button>`
  el.innerHTML = `<div class="pg-chart-tip-title">${escapeHtml(title)}</div>${rows}${linkHtml}`

  const btn = el.querySelector<HTMLButtonElement>(".pg-chart-tip-link")
  if (btn) btn.onclick = () => {
    hideTooltip(el)
    linkRef.current?.link.onSelect(linkRef.current.index)
  }

  // Highest drawn point at this index, so the box clears every series.
  let anchorY = chart.chartArea.bottom
  let anchorX = tooltip.caretX
  for (const p of tooltip.dataPoints) {
    if (p.element.y < anchorY) anchorY = p.element.y
    anchorX = p.element.x
  }

  const { offsetLeft, offsetTop } = chart.canvas
  el.style.opacity = "1"
  el.style.pointerEvents = "auto"
  const { left, top } = tooltipPlacement({
    anchorX,
    anchorY,
    tip: { width: el.offsetWidth, height: el.offsetHeight },
    canvas: { width: chart.canvas.clientWidth, height: chart.canvas.clientHeight },
    gap: 12,
  })
  el.style.left = `${offsetLeft + left}px`
  el.style.top = `${offsetTop + top}px`
}


function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)
}

// — Bucket helpers ported from src/ui/dashboard/client.ts —

export function localHourKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`
}

export function localDateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Local midnight of the day containing `ref`, offset by whole days. */
export function localDayStart(ref: Date, dayDelta: number): Date {
  return new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + dayDelta, 0, 0, 0, 0)
}

/** Local midnight on the 1st of the month containing `ref`, offset by whole months. */
export function localMonthStart(ref: Date, monthDelta: number): Date {
  return new Date(ref.getFullYear(), ref.getMonth() + monthDelta, 1, 0, 0, 0, 0)
}

export type TimeBucketRange = "today" | "week" | "7d" | "28d" | "30d" | "month"

/** How many daily buckets each trailing window holds. */
export const TRAILING_WINDOW_DAYS: Record<"7d" | "28d" | "30d", number> = { "7d": 7, "28d": 28, "30d": 30 }

/**
 * Local midnight of a "YYYY-MM-DD" day, or null when the string is not one.
 * Parsed field by field rather than through `new Date(s)`, which reads a bare
 * date as UTC midnight and so lands on the previous day west of Greenwich.
 */
export function parseLocalDateKey(key: string | null | undefined): Date | null {
  if (typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null
  const [y, m, d] = key.split("-").map(Number) as [number, number, number]
  const date = new Date(y, m - 1, d, 0, 0, 0, 0)
  // Rejects the impossible days a regex still admits (2026-13-99 rolls over).
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null
  return date
}

export interface TimeBuckets {
  keys: string[]
  labels: string[]
  isDaily: boolean
}

/**
 * `periodOffset` shifts the window backwards for the two calendar ranges:
 * whole weeks for "week", whole months for "month". Ignored by the rest.
 *
 * `endDate` ("YYYY-MM-DD") pins the trailing windows to a chosen last day
 * instead of ending them at today; it is ignored by every other range, and an
 * unparseable value falls back to the trailing window.
 */
export function buildTimeBuckets(
  range: TimeBucketRange,
  periodOffset: number,
  now: Date = new Date(),
  endDate?: string | null,
): TimeBuckets {
  const keys: string[] = []
  const labels: string[] = []
  const isDaily = range !== "today"

  if (range === "today") {
    // Follows periodOffset for the same reason computeTimeRange does: the
    // chart and the summary must describe the same day.
    const day = localDayStart(now, periodOffset)
    for (let h = 0; h < 24; h++) {
      const d = new Date(day)
      d.setHours(h, 0, 0, 0)
      keys.push(localHourKey(d))
      const next = String((h + 1) % 24).padStart(2, "0")
      labels.push(`${String(h).padStart(2, "0")}:00 – ${next}:00`)
    }
  } else if (range === "week") {
    const ref = new Date(now)
    ref.setDate(ref.getDate() + periodOffset * 7)
    const day = ref.getDay()
    const monday = new Date(ref)
    monday.setDate(ref.getDate() - ((day + 6) % 7))
    monday.setHours(0, 0, 0, 0)
    const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday)
      d.setDate(monday.getDate() + i)
      keys.push(localDateKey(d))
      labels.push(`${weekdays[i]} ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`)
    }
  } else if (range === "month") {
    const first = localMonthStart(now, periodOffset)
    const nextFirst = localMonthStart(now, periodOffset + 1)
    for (const d = new Date(first); d < nextFirst; d.setDate(d.getDate() + 1)) {
      keys.push(localDateKey(d))
      labels.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }))
    }
  } else {
    const days = TRAILING_WINDOW_DAYS[range]
    // The picked day is the last day *in* the window, so the window opens
    // days-1 days before it; counted in calendar days so a DST shift cannot
    // slide the first bucket onto the wrong date.
    const pinned = parseLocalDateKey(endDate)
    const first = pinned
      ? new Date(pinned.getFullYear(), pinned.getMonth(), pinned.getDate() - (days - 1), 0, 0, 0, 0)
      : localDayStart(now, -(days - 1))
    for (let i = 0; i < days; i++) {
      const d = new Date(first)
      d.setDate(first.getDate() + i)
      keys.push(localDateKey(d))
      labels.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }))
    }
  }

  return { keys, labels, isDaily }
}

export function utcHourToBucketKey(utcHour: string, isDaily: boolean): string {
  const d = new Date(utcHour + ":00:00Z")
  return isDaily ? localDateKey(d) : localHourKey(d)
}
