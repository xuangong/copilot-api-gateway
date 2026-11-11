import * as RadixDialog from "@radix-ui/react-dialog"
import type { ReactNode } from "react"
import { cn } from "./cn"

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  /** Buttons, right-aligned under the body. */
  footer?: ReactNode
  className?: string
  /** Where focus goes on close. Radix returns it to the opener by default; pass this when the opener may be gone or disabled. */
  onCloseAutoFocus?: (event: Event) => void
}

/** A centred modal: Esc and a click outside close it, focus is trapped and returned (Radix). */
export function Dialog({ open, onOpenChange, title, description, children, footer, className, onCloseAutoFocus }: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <RadixDialog.Content
          {...(description ? {} : { "aria-describedby": undefined })}
          onCloseAutoFocus={onCloseAutoFocus}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-lg focus:outline-none",
            className,
          )}
        >
          <div className="space-y-1">
            <RadixDialog.Title className="text-base font-semibold text-fg">{title}</RadixDialog.Title>
            {description ? <RadixDialog.Description className="text-[13px] text-fg-muted">{description}</RadixDialog.Description> : null}
          </div>
          {children}
          {footer ? <div className="flex flex-wrap justify-end gap-2">{footer}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
