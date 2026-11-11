import type { ComponentProps } from "react"
import { cn } from "./cn"

export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("rounded-lg border border-border bg-background p-4", className)} {...props} />
}

/** A section title; `as="h3"` for one nested under another section's h2. */
export function SectionHeading({ className, as: Heading = "h2", ...props }: ComponentProps<"h2"> & { as?: "h2" | "h3" }) {
  return <Heading className={cn("text-sm font-semibold text-fg", className)} {...props} />
}
