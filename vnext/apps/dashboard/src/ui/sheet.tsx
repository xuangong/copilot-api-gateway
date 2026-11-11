import * as Dialog from "@radix-ui/react-dialog"
import { X } from "lucide-react"
import type { ReactElement, ReactNode } from "react"
import { cn } from "./cn"

interface SheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Read out by screen readers when the sheet opens; visually hidden. */
  title: string
  closeLabel: string
  /** The button that opens the sheet. Inside the Root, so Radix can wire its ARIA state and return focus to it on close. */
  trigger: ReactElement
  children: ReactNode
  className?: string
}

/** A panel that slides in from the left edge, with focus trapped inside and Esc to close. */
export function Sheet({ open, onOpenChange, title, closeLabel, trigger, children, className }: SheetProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn("fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border bg-panel shadow-xl outline-none", className)}
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <Dialog.Close
            aria-label={closeLabel}
            className="absolute right-2 top-2 rounded-md p-1.5 text-fg-muted hover:bg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text"
          >
            <X className="size-4" />
          </Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
