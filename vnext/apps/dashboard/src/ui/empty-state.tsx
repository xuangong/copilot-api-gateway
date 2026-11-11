import type { ReactNode } from "react"

export function EmptyState({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
      <p className="text-sm font-medium text-fg-muted">{title}</p>
      {description ? <p className="mt-1 text-[13px] text-fg-subtle">{description}</p> : null}
    </div>
  )
}
