import { cn } from "./cn"

export type MeterTone = "brand" | "warn" | "danger" | "muted"

const FILL: Record<MeterTone, string> = {
  brand: "bg-brand",
  warn: "bg-warn",
  danger: "bg-danger",
  muted: "bg-fg-subtle",
}

/** The usage colour used by quota bars: brand up to 70%, warn above, danger above 90%. */
export function meterTone(percent: number): MeterTone {
  if (percent > 90) return "danger"
  if (percent > 70) return "warn"
  return "brand"
}

/** A thin horizontal bar. Decorative: the text next to it carries the numbers. */
export function Meter({ percent, tone = "brand", className }: { percent: number; tone?: MeterTone; className?: string }) {
  const width = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
  return (
    <div aria-hidden="true" className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div className={cn("h-full rounded-full transition-[width]", FILL[tone])} style={{ width: `${width}%` }} />
    </div>
  )
}
