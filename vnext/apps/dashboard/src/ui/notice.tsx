import type { AriaRole, ReactNode } from "react"
import { cn } from "./cn"

const TONES = {
  info: "border-border bg-panel text-fg-muted",
  success: "border-success/30 bg-success/10 text-success-text",
  warn: "border-warn/30 bg-warn/10 text-warn-text",
  danger: "border-danger/30 bg-danger/10 text-danger-text",
} as const

/** An inline message. Danger notices are announced (role=alert) unless a role is given; the others are not. */
export function Notice({ tone = "info", role, className, children }: { tone?: keyof typeof TONES; role?: AriaRole; className?: string; children: ReactNode }) {
  return (
    <div role={role ?? (tone === "danger" ? "alert" : undefined)} className={cn("rounded-md border px-3 py-2 text-[13px]", TONES[tone], className)}>
      {children}
    </div>
  )
}
