import * as RadixTooltip from "@radix-ui/react-tooltip"
import type { ReactElement, ReactNode } from "react"

/** Wrap the app once; every Tooltip needs it and takes its delay from here. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return <RadixTooltip.Provider delayDuration={200}>{children}</RadixTooltip.Provider>
}

/**
 * A hover/focus label. It describes the trigger but does not name it: an
 * icon-only trigger must carry its own aria-label.
 */
interface TooltipProps {
  content: ReactNode
  children: ReactElement
  side?: "top" | "right" | "bottom" | "left"
  /** Render the trigger alone, e.g. when the label is already visible. */
  disabled?: boolean
}

export function Tooltip({ content, children, side = "right", disabled = false }: TooltipProps) {
  if (disabled) return children
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 rounded-md border border-border bg-fg px-2 py-1 text-xs text-background shadow-md"
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  )
}
