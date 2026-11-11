import { useMemo, useState } from "react"
import type { DistributionRow } from "../../state/usage"
import { paletteFor } from "../../components/TimeSeriesChart"
import { useT } from "../../state/i18n"
import { Card, SectionHeading } from "../../ui/card"
import { TBody, Table, Td, Th } from "../../ui/table"

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
    <Card className="mt-5">
      {/* h3: these cards sit under the page's distribution heading (h2). */}
      <SectionHeading as="h3" className="mb-4">
        {title}
      </SectionHeading>

      <div className="space-y-3 mb-6" onMouseLeave={() => setHovered(null)}>
        <StackedBar label="Requests" rows={rows} pct={reqPct} palette={palette} hovered={hovered} onHover={setHovered} />
        <StackedBar label="Input" rows={rows} pct={inPct} palette={palette} hovered={hovered} onHover={setHovered} />
        <StackedBar label="Output" rows={rows} pct={outPct} palette={palette} hovered={hovered} onHover={setHovered} />

        <div className="h-5 flex items-center">
          {hoveredRow ? (
            <p className="text-xs text-fg-muted tabular-nums">
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
              <span className="text-xs text-fg-muted">{r.label}</span>
            </div>
          ))}
        </div>
      </div>

      <Table className="whitespace-nowrap" label={ariaLabel ?? title} aria-label={ariaLabel ?? title}>
        <thead>
          <tr>
            <Th>{title}</Th>
            {showRoutedModels ? <Th>{t("dash.routedModels")}</Th> : null}
            <Th numeric>{t("dash.requests")}</Th>
            <Th numeric>{t("dash.input")}</Th>
            <Th numeric>{t("dash.output")}</Th>
            <Th numeric>{t("dash.cacheRead")}</Th>
            <Th numeric>{t("dash.cacheCreation")}</Th>
            <Th numeric>{t("dash.totalTokens")}</Th>
            <Th numeric>{t("dash.cost")}</Th>
          </tr>
        </thead>
        <TBody>
          {rows.map((r, i) => {
            const isHover = hovered === r.id
            const someoneElse = hovered && hovered !== r.id
            return (
              <tr
                key={r.id}
                onMouseEnter={() => setHovered(r.id)}
                onMouseLeave={() => setHovered(null)}
                className={`transition-all duration-150 cursor-pointer ${
                  isHover ? "bg-muted" : someoneElse ? "opacity-40" : ""
                }`}
              >
                <Th row>
                  <span className="inline-flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: palette[i % palette.length] }} />
                    <span>{r.label}</span>
                  </span>
                </Th>
                {showRoutedModels ? <Td className="text-fg-muted">{r.routedModels?.join(", ") ?? "—"}</Td> : null}
                <Td numeric className="text-fg-muted">{fmt(r.requests)}</Td>
                <Td numeric className="text-fg-muted">{fmt(r.input)}</Td>
                <Td numeric className="text-fg-muted">{fmt(r.output)}</Td>
                <Td numeric className="text-fg-muted">{fmt(r.cacheRead)}</Td>
                <Td numeric className="text-fg-muted">{fmt(r.cacheCreation)}</Td>
                <Td numeric className="text-fg-muted">{fmt(r.input + r.output + r.cacheRead + r.cacheCreation)}</Td>
                <Td numeric className="text-fg-muted">{r.costUSD > 0 ? "$" + r.costUSD.toFixed(4) : "—"}</Td>
              </tr>
            )
          })}
        </TBody>
      </Table>
    </Card>
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
      <p className="text-xs text-fg-subtle mb-1.5">{label}</p>
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
