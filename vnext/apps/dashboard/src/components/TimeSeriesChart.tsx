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
            ? { enabled: false, external: (ctx) => renderLinkTooltip(ctx, tooltipRef.current, unitLabel, linkRef, hideTimer) }
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

  return (
    <div style={{ height, width: "100%", position: "relative" }}>
      <canvas ref={canvasRef} />
      {pointLink ? (
        <div
          ref={tooltipRef}
          className="pg-chart-tip"
          // Hovering the tooltip cancels the pending hide, so the link can be
          // reached; leaving it hides immediately.
          onMouseEnter={() => { if (hideTimer.current !== null) { clearTimeout(hideTimer.current); hideTimer.current = null } }}
          onMouseLeave={() => hideTooltip(tooltipRef.current)}
        />
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
) {
  if (!el || !linkRef.current) return
  const { chart, tooltip } = ctx

  if (tooltip.opacity === 0) {
    // Do not hide straight away: the mouse may be on its way into the tooltip,
    // and leaving the canvas is what fires this in the first place.
    if (hideTimer.current !== null) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => hideTooltip(el), 220)
    return
  }
  if (hideTimer.current !== null) { clearTimeout(hideTimer.current); hideTimer.current = null }

  const index = tooltip.dataPoints[0]?.dataIndex ?? 0
  linkRef.current = { ...linkRef.current, index }

  const title = tooltip.title[0] ?? ""
  const rows = tooltip.dataPoints
    .map((p) => `<div class="pg-chart-tip-row"><span class="pg-chart-tip-dot" style="background:${p.dataset.borderColor}"></span>${escapeHtml(String(p.dataset.label ?? ""))}<b>${Number(p.parsed.y).toLocaleString()}${escapeHtml(unitLabel)}</b></div>`)
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

  const { offsetLeft, offsetTop } = chart.canvas
  el.style.opacity = "1"
  el.style.pointerEvents = "auto"
  el.style.left = `${offsetLeft + tooltip.caretX}px`
  el.style.top = `${offsetTop + tooltip.caretY}px`
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

export type TimeBucketRange = "today" | "week" | "7d" | "30d" | "month"

export interface TimeBuckets {
  keys: string[]
  labels: string[]
  isDaily: boolean
}

/**
 * `periodOffset` shifts the window backwards for the two calendar ranges:
 * whole weeks for "week", whole months for "month". Ignored by the rest.
 */
export function buildTimeBuckets(
  range: TimeBucketRange,
  periodOffset: number,
  now: Date = new Date(),
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
    const days = range === "7d" ? 7 : 30
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(d.getDate() - i)
      d.setHours(0, 0, 0, 0)
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
