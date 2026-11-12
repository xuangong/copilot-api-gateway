import * as RadixDialog from "@radix-ui/react-dialog"
import { type ReactNode, useEffect, useState } from "react"
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
  /** "alertdialog" for a question that interrupts the task, such as confirming a delete. */
  role?: "dialog" | "alertdialog"
  /** A click or focus outside; preventDefault() keeps the dialog open. */
  onInteractOutside?: (event: Event) => void
}

/** A centred modal: Esc and a click outside close it, focus is trapped and returned (Radix). */
export function Dialog({ open, onOpenChange, title, description, children, footer, className, onCloseAutoFocus, role, onInteractOutside }: DialogProps) {
  // Callers usually unmount the whole dialog on close, which skips Radix's focus
  // return. Remember what had focus when it first rendered (before Radix moves
  // focus in) and give it back on unmount if focus was left on <body>.
  const [opener] = useState(() => (typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null)))
  useEffect(
    () => () => {
      setTimeout(() => {
        const active = document.activeElement
        if (opener?.isConnected && (!active || active === document.body)) opener.focus()
      }, 0)
    },
    [opener],
  )
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <RadixDialog.Content
          {...(description ? {} : { "aria-describedby": undefined })}
          {...(role ? { role } : {})}
          onCloseAutoFocus={onCloseAutoFocus}
          // Toasts sit above the overlay; dismissing one must not close the dialog
          // (that would, for example, abort a device-flow login mid-poll).
          onInteractOutside={(event) => {
            const target = event.target
            if (target instanceof Element && target.closest("[data-toast-host]")) event.preventDefault()
            else onInteractOutside?.(event)
          }}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-lg focus:outline-none",
            className,
          )}
        >
          <div className="space-y-1">
            <RadixDialog.Title className="text-base font-semibold text-fg">{title}</RadixDialog.Title>
            {description ? <RadixDialog.Description className="text-body text-fg-muted">{description}</RadixDialog.Description> : null}
          </div>
          {children}
          {footer ? <div className="flex flex-wrap justify-end gap-2">{footer}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
