import type { ReactNode } from "react"
import { cn } from "./cn"

const TONES = {
  info: "border-border bg-panel text-fg-muted",
  warn: "border-warn/30 bg-warn/10 text-warn-text",
  danger: "border-danger/30 bg-danger/10 text-danger-text",
} as const

/** An inline message. Danger notices are announced (role=alert); the others are not. */
export function Notice({ tone = "info", className, children }: { tone?: keyof typeof TONES; className?: string; children: ReactNode }) {
  return (
    <div role={tone === "danger" ? "alert" : undefined} className={cn("rounded-md border px-3 py-2 text-[13px]", TONES[tone], className)}>
      {children}
    </div>
  )
}
