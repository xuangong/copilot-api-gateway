import { useMemo, useState } from "react"
import type { DistributionRow } from "../../state/usage"
import { paletteFor } from "../../components/TimeSeriesChart"
import { useT } from "../../state/i18n"

interface Props {
  title: string
  rows: DistributionRow[]
  showRoutedModels?: boolean
  ariaLabel?: string
}

type DimensionMetric = "requests" | "input" | "output"

function fmt(n: number): string {
  return n.toLocaleString()
}

function percents(rows: DistributionRow[], metric: DimensionMetric): number[] {
  const total = rows.reduce((acc, r) => acc + (r[metric] || 0), 0)
  if (total <= 0) return rows.map(() => 0)
  return rows.map((r) => Math.round(((r[metric] || 0) / total) * 1000) / 10)
}

export function UsageDistributionTable({ title, rows, showRoutedModels = false, ariaLabel }: Props) {
  const [hovered, setHovered] = useState<string | null>(null)
  const isDark =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-theme") !== "light"
  const palette = paletteFor(isDark ? "dark" : "light")
  const t = useT()

  const reqPct = useMemo(() => percents(rows, "requests"), [rows])
  const inPct = useMemo(() => percents(rows, "input"), [rows])
  const outPct = useMemo(() => percents(rows, "output"), [rows])

  if (rows.length === 0) return null

  const hoveredRow = hovered ? rows.find((r) => r.id === hovered) ?? null : null
  const hoveredIdx = hoveredRow ? rows.indexOf(hoveredRow) : -1

  return (
    <div className="glass-card p-4 sm:p-6 mt-5 animate-in delay-1">
      <span className="text-xs font-medium text-themed-dim uppercase tracking-widest mb-4 block">
        {title}
      </span>

      <div className="space-y-3 mb-6" onMouseLeave={() => setHovered(null)}>
        <StackedBar label="Requests" rows={rows} pct={reqPct} palette={palette} hovered={hovered} onHover={setHovered} />
        <StackedBar label="Input" rows={rows} pct={inPct} palette={palette} hovered={hovered} onHover={setHovered} />
        <StackedBar label="Output" rows={rows} pct={outPct} palette={palette} hovered={hovered} onHover={setHovered} />

        <div className="h-5 flex items-center">
          {hoveredRow ? (
            <p className="text-xs text-themed-secondary font-mono">
              {hoveredRow.label}
              {"  —  "}
              {reqPct[hoveredIdx]}% reqs · {inPct[hoveredIdx]}% in · {outPct[hoveredIdx]}% out
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {rows.map((r, i) => (
            <div
              key={`leg-${r.id}`}
              className="flex items-center gap-2 cursor-pointer transition-opacity duration-150"
              onMouseEnter={() => setHovered(r.id)}
              onMouseLeave={() => setHovered(null)}
              style={{ opacity: hovered && hovered !== r.id ? 0.35 : 1 }}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: palette[i % palette.length] }} />
              <span className="text-[11px] text-themed-secondary">{r.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm whitespace-nowrap" aria-label={ariaLabel ?? title}>
          <thead>
            <tr className="border-b" style={{ borderColor: "var(--border-color)" }}>
              <Th align="left">{title}</Th>
              {showRoutedModels ? <Th align="left">{t("dash.routedModels")}</Th> : null}
              <Th>{t("dash.requests")}</Th>
              <Th>{t("dash.input")}</Th>
              <Th>{t("dash.output")}</Th>
              <Th>{t("dash.cacheRead")}</Th>
              <Th>{t("dash.cacheCreation")}</Th>
              <Th>{t("dash.totalTokens")}</Th>
              <Th className="pr-0">{t("dash.cost")}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const isHover = hovered === r.id
              const someoneElse = hovered && hovered !== r.id
              return (
                <tr
                  key={r.id}
                  onMouseEnter={() => setHovered(r.id)}
                  onMouseLeave={() => setHovered(null)}
                  className={`transition-all duration-150 cursor-pointer border-b ${
                    isHover ? "bg-surface-700/50" : someoneElse ? "opacity-40" : ""
                  }`}
                  style={{ borderColor: "var(--border-color)" }}
                >
                  <td className="py-2.5 pr-4 text-left">
                    <span className="inline-flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: palette[i % palette.length] }} />
                      <span className="text-xs text-themed">{r.label}</span>
                    </span>
                  </td>
                  {showRoutedModels ? <td className="py-2.5 pr-4 text-left text-xs text-themed-secondary">{r.routedModels?.join(", ") ?? "—"}</td> : null}
                  <Td>{fmt(r.requests)}</Td>
                  <Td>{fmt(r.input)}</Td>
                  <Td>{fmt(r.output)}</Td>
                  <Td>{fmt(r.cacheRead)}</Td>
                  <Td>{fmt(r.cacheCreation)}</Td>
                  <Td>{fmt(r.input + r.output + r.cacheRead + r.cacheCreation)}</Td>
                  <Td className="pr-0">{r.costUSD > 0 ? "$" + r.costUSD.toFixed(4) : "—"}</Td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

interface StackedBarProps {
  label: string
  rows: DistributionRow[]
  pct: number[]
  palette: string[]
  hovered: string | null
  onHover: (label: string | null) => void
}

function StackedBar({ label, rows, pct, palette, hovered, onHover }: StackedBarProps) {
  return (
    <div>
      <p className="text-[11px] text-themed-dim mb-1.5">{label}</p>
      <div className="flex h-[14px] gap-[2px] rounded-full overflow-hidden">
        {rows.map((r, i) => {
          const p = pct[i] ?? 0
          if (p <= 0) return null
          const dim = hovered && hovered !== r.id
          return (
            <div
              key={`${label}-${r.id}`}
              onMouseEnter={() => onHover(r.id)}
              title={`${r.label}: ${p}%`}
              className="h-full transition-all duration-200 cursor-pointer"
              style={{
                width: `${p}%`,
                background: palette[i % palette.length],
                opacity: dim ? 0.25 : 0.85,
              }}
            />
          )
        })}
      </div>
    </div>
  )
}

function Th({
  children,
  align = "right",
  className = "",
}: {
  children: React.ReactNode
  align?: "left" | "right"
  className?: string
}) {
  const alignCls = align === "left" ? "text-left" : "text-right"
  return (
    <th
      className={`py-2.5 pr-4 text-xs font-medium text-themed-dim uppercase tracking-widest ${alignCls} ${className}`}
    >
      {children}
    </th>
  )
}

function Td({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={`py-2.5 pr-4 text-right text-themed-secondary font-mono text-xs ${className}`}>{children}</td>
  )
}
