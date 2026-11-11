import type { ReactNode } from "react"
import { cn } from "./cn"

const TONES = {
  neutral: "border-control bg-panel text-fg-muted",
  brand: "border-brand-text/30 bg-brand-text/10 text-brand-text",
  success: "border-success/30 bg-success/10 text-success-text",
  warn: "border-warn/30 bg-warn/10 text-warn-text",
  danger: "border-danger/30 bg-danger/10 text-danger-text",
} as const

export function Badge({ tone = "neutral", className, children }: { tone?: keyof typeof TONES; className?: string; children: ReactNode }) {
  return <span className={cn("inline-flex items-center rounded border px-1.5 text-xs leading-5", TONES[tone], className)}>{children}</span>
}
