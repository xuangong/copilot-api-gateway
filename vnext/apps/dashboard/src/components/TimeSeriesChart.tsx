import { useEffect, useRef, useState } from "react"

// Chart.js is loaded via <script src="/cdn/chart.js"> in page.ts and exposed
// as window.Chart. We avoid bundling it; this typedef just prevents `any`.
declare global {
  interface Window {
    Chart?: ChartCtor
    __currentTheme?: "dark" | "light"
  }
}

interface ChartCtor {
  new (canvas: HTMLCanvasElement, cfg: unknown): ChartInstance
}
interface ChartInstance {
  destroy(): void
  stop(): void
  update(): void
}

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

interface Props {
  labels: string[]
  datasets: ChartDataset[]
  height?: number
  /** tooltip suffix per value, e.g. " tokens" / " ms" / " req" */
  unitLabel?: string
  /** y-tick formatter; if omitted uses K/M abbreviations */
  yTickFormat?: (v: number) => string
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

export function TimeSeriesChart({ labels, datasets, height = 300, unitLabel = "", yTickFormat }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const chartRef = useRef<ChartInstance | null>(null)
  const [themeTick, setThemeTick] = useState(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const Chart = window.Chart
    if (!Chart) return

    // Destroy previous instance before re-creating.
    if (chartRef.current) {
      try { chartRef.current.stop() } catch {}
      try { chartRef.current.destroy() } catch {}
      chartRef.current = null
    }

    const dark = isDarkTheme()
    const gridC = cssVar("--grid-color")
    const tickC = cssVar("--tick-color")
    const ttBg = dark ? "rgba(22, 25, 34, 0.95)" : "rgba(255, 255, 255, 0.98)"
    const ttBorder = dark ? "rgba(255, 255, 255, 0.12)" : "rgba(0, 0, 0, 0.08)"
    const ttText = dark ? "#f3f4f6" : "#111827"
    const ttText2 = dark ? "#d1d5db" : "#374151"
    const ptBg = dark ? "#161922" : "#ffffff"
    const fillAlpha = dark ? "20" : "30"
    const tickFmt = yTickFormat ?? defaultYTick

    const cfg = {
      type: "line",
      data: {
        labels,
        datasets: datasets.map((d) => ({
          label: d.label,
          data: d.data,
          borderColor: d.color,
          backgroundColor: d.fill === false ? "transparent" : d.color + fillAlpha,
          borderWidth: d.dashed ? 1.5 : 2,
          borderDash: d.dashed ? [4, 4] : undefined,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBorderWidth: 2,
          pointHoverBackgroundColor: ptBg,
          pointHoverBorderColor: d.color,
          tension: 0.4,
          fill: d.fill !== false,
          borderCapStyle: "round",
          borderJoinStyle: "round",
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400, easing: "easeOutQuart" },
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            position: "bottom",
            labels: {
              color: tickC,
              font: { size: 11, family: "'Outfit', sans-serif", weight: "400" },
              boxWidth: 8, boxHeight: 8, padding: 20,
              usePointStyle: true, pointStyle: "circle",
            },
          },
          tooltip: {
            backgroundColor: ttBg, borderColor: ttBorder, borderWidth: 1, cornerRadius: 8,
            titleColor: ttText,
            titleFont: { family: "'Outfit', sans-serif", size: 12, weight: "500" },
            bodyColor: ttText2,
            bodyFont: { family: "'IBM Plex Mono', monospace", size: 11 },
            padding: { top: 10, bottom: 10, left: 14, right: 14 },
            boxPadding: 6, usePointStyle: true,
            callbacks: {
              label: (ctx: { dataset: { label: string }; parsed: { y: number } }) =>
                " " + ctx.dataset.label + "  " + ctx.parsed.y.toLocaleString() + unitLabel,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: tickC, font: { size: 10, family: "'Outfit', sans-serif" }, maxRotation: 0, padding: 8 },
            border: { display: false },
          },
          y: {
            beginAtZero: true,
            grid: { color: gridC, lineWidth: 0.5, drawTicks: false },
            ticks: {
              color: tickC,
              font: { size: 10, family: "'IBM Plex Mono', monospace" },
              padding: 12,
              callback: tickFmt,
            },
            border: { display: false },
          },
        },
      },
    }

    try {
      chartRef.current = new Chart(canvas, cfg)
    } catch {
      // double-init guard
    }

    return () => {
      if (chartRef.current) {
        try { chartRef.current.stop() } catch {}
        try { chartRef.current.destroy() } catch {}
        chartRef.current = null
      }
    }
  }, [labels, datasets, unitLabel, yTickFormat, themeTick])

  // Re-render on theme toggle so colors track the theme.
  useEffect(() => {
    const handler = () => setThemeTick((n) => n + 1)
    window.addEventListener("theme-changed", handler)
    return () => window.removeEventListener("theme-changed", handler)
  }, [])

  if (typeof window !== "undefined" && !window.Chart) {
    return (
      <div className="flex items-center justify-center text-themed-dim text-xs" style={{ height }}>
        Chart.js failed to load
      </div>
    )
  }

  return (
    <div style={{ height, position: "relative" }}>
      <canvas ref={canvasRef} />
    </div>
  )
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

export type TimeBucketRange = "today" | "week" | "7d" | "30d"

export interface TimeBuckets {
  /** ordered bucket keys (local-time) */
  keys: string[]
  /** human labels parallel to keys */
  labels: string[]
  /** true if buckets are days (vs hours) */
  isDaily: boolean
}

export function buildTimeBuckets(range: TimeBucketRange, weekOffset: number): TimeBuckets {
  const now = new Date()
  const keys: string[] = []
  const labels: string[] = []
  const isDaily = range !== "today"

  if (range === "today") {
    for (let h = 0; h < 24; h++) {
      const d = new Date(now)
      d.setHours(h, 0, 0, 0)
      keys.push(localHourKey(d))
      const next = String((h + 1) % 24).padStart(2, "0")
      labels.push(`${String(h).padStart(2, "0")}:00 – ${next}:00`)
    }
  } else if (range === "week") {
    const ref = new Date(now)
    ref.setDate(ref.getDate() + weekOffset * 7)
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

/** Convert a "YYYY-MM-DDTHH" UTC-hour string to local bucket key. */
export function utcHourToBucketKey(utcHour: string, isDaily: boolean): string {
  const d = new Date(utcHour + ":00:00Z")
  return isDaily ? localDateKey(d) : localHourKey(d)
}
