// apps/dashboard/src/tabs/upstreams/protection/ErrorBarChart.tsx
import { useEffect, useRef, useState } from "react"
import { BarController, BarElement, CategoryScale, Chart, Legend, LinearScale, LineController, LineElement, PointElement, Tooltip, type ChartConfiguration } from "chart.js"
import { chartFont, cssVar, isDarkTheme } from "../../../components/TimeSeriesChart"
import { classColors } from "./error-chart"
import type { ErrorClassKey } from "../../../api/protection"

Chart.register(BarController, BarElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, Legend, Tooltip)

interface Props {
  labels: string[]
  /** Stacked bars, one per error class that occurred. */
  bars: Array<{ key: ErrorClassKey; label: string; data: number[] }>
  /** The line over the bars: every request, whatever its outcome. */
  requests: { label: string; data: number[] }
  height?: number
  yTitle?: string
  /** Text alternative for the canvas, e.g. the range and the totals. */
  ariaLabel?: string
}

/** Stacked error counts per bucket with the request count as a line. Rebuilt on data or theme change. */
export function ErrorBarChart({ labels, bars, requests, height = 260, yTitle, ariaLabel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [themeTick, setThemeTick] = useState(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dark = isDarkTheme()
    const colors = classColors(dark)
    const tick = cssVar("--tick-color") || (dark ? "#9ca3af" : "#4b5563")
    const grid = cssVar("--grid-color") || (dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)")
    const surface = cssVar("--surface-800") || (dark ? "#1a1a1a" : "#ffffff")
    const css = getComputedStyle(document.documentElement)
    const read = (name: string) => css.getPropertyValue(name)
    const sans = chartFont(read, "sans")
    const mono = chartFont(read, "mono")
    const config = {
      type: "bar",
      data: {
        labels,
        datasets: [
          ...bars.map((bar) => ({ type: "bar" as const, label: bar.label, data: bar.data, backgroundColor: colors[bar.key], stack: "errors", borderWidth: 1, borderColor: surface })),
          { type: "line" as const, order: -1, label: requests.label, data: requests.data, borderColor: colors.requests, backgroundColor: colors.requests, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.25, fill: false },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: true, labels: { color: tick, font: { family: sans, size: 12 } } } },
        scales: {
          x: { stacked: true, ticks: { color: tick, font: { family: sans, size: 12 }, maxRotation: 0, autoSkip: true }, grid: { display: false } },
          y: {
            stacked: true, beginAtZero: true,
            ticks: { color: tick, font: { family: mono, size: 12 }, precision: 0 },
            grid: { color: grid },
            title: yTitle ? { display: true, text: yTitle, color: tick, font: { family: sans, size: 12 } } : { display: false },
          },
        },
      },
    } as unknown as ChartConfiguration
    const chart = new Chart(canvas, config)
    return () => chart.destroy()
  }, [labels, bars, requests, yTitle, themeTick])

  useEffect(() => {
    const handler = () => setThemeTick((n) => n + 1)
    window.addEventListener("theme-changed", handler)
    return () => window.removeEventListener("theme-changed", handler)
  }, [])

  return <div style={{ height, width: "100%", position: "relative" }}><canvas ref={canvasRef} role="img" aria-label={ariaLabel} /></div>
}
