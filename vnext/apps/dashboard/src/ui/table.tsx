import type { ComponentProps } from "react"
import { cn } from "./cn"

/**
 * A table in a horizontally scrollable frame. With a `label`, the frame is a
 * named, focusable region so keyboard users can scroll it.
 */
export function Table({ className, label, ...props }: ComponentProps<"table"> & { label?: string }) {
  const table = <table className={cn("w-full border-collapse text-[13px]", className)} {...props} />
  if (label) {
    return (
      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        className="min-w-0 overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text"
      >
        {table}
      </div>
    )
  }
  return <div className="min-w-0 overflow-x-auto">{table}</div>
}

/** A column header; with `row`, a row header styled like a body cell. */
export function Th({ className, numeric = false, row = false, ...props }: ComponentProps<"th"> & { numeric?: boolean; row?: boolean }) {
  if (row) return <th scope="row" className={cn("border-b border-border px-3 py-2 text-left font-normal text-fg", className)} {...props} />
  return (
    <th
      scope="col"
      className={cn("h-9 border-b border-border px-3 text-xs font-medium text-fg-muted", numeric ? "text-right" : "text-left", className)}
      {...props}
    />
  )
}

/** A table body whose last row has no bottom border, so it does not double the frame's edge. */
export function TBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={cn("[&>tr:last-child>*]:border-b-0", className)} {...props} />
}

export function Td({ className, numeric = false, ...props }: ComponentProps<"td"> & { numeric?: boolean }) {
  return <td className={cn("border-b border-border px-3 py-2 text-fg", numeric && "text-right tabular-nums", className)} {...props} />
}
