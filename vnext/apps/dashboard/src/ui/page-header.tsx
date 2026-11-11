import type { ReactNode } from "react"

interface Props {
  title: string
  description?: ReactNode
  /** The page's own actions, e.g. refresh; right-aligned, wrapping under the title on narrow screens. */
  actions?: ReactNode
}

export function PageHeader({ title, description, actions }: Props) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {description ? <p className="mt-1 max-w-[65ch] text-[13px] leading-relaxed text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}
