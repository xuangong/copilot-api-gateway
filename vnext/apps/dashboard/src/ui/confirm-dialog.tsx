import { useState } from "react"
import { Button } from "./button"
import { Dialog } from "./dialog"

export interface ConfirmRequest {
  title: string
  /** What going ahead does, when the title alone doesn't say. */
  description?: string
  /** The action by name ("Delete", "Sign out"), never "OK". */
  confirmLabel: string
  /** Destructive actions get the red button. */
  danger?: boolean
}

interface ActionsProps {
  cancelLabel: string
  confirmLabel: string
  danger?: boolean
  onAnswer: (ok: boolean) => void
}

/** Cancel first, so it is where focus lands when the dialog opens. */
export function ConfirmActions({ cancelLabel, confirmLabel, danger = false, onAnswer }: ActionsProps) {
  return (
    <>
      <Button variant="secondary" onClick={() => onAnswer(false)}>{cancelLabel}</Button>
      <Button variant={danger ? "danger" : "primary"} onClick={() => onAnswer(true)}>{confirmLabel}</Button>
    </>
  )
}

/**
 * The browser's confirm box blocked the page; this dialog does not. The second
 * click of a double-click on the button that asked lands on whatever the dialog
 * has put under the pointer, so for this long it can neither confirm nor close it.
 */
export const SETTLE_MS = 400

/** Drops a "yes" that comes too soon after the question to be an answer to it. */
export function ignoreEarlyYes(onAnswer: (ok: boolean) => void, openedAt: number, now: () => number = () => performance.now()) {
  return (ok: boolean) => {
    if (ok && now() - openedAt < SETTLE_MS) return
    onAnswer(ok)
  }
}

/** In place of the browser's confirm box: Esc, a click outside and Cancel all answer no. */
export function ConfirmDialog({ request, cancelLabel, onAnswer }: { request: ConfirmRequest; cancelLabel: string; onAnswer: (ok: boolean) => void }) {
  const [openedAt] = useState(() => performance.now())
  return (
    <Dialog
      open
      role="alertdialog"
      onOpenChange={(open) => {
        if (!open) onAnswer(false)
      }}
      onInteractOutside={(event) => {
        if (performance.now() - openedAt < SETTLE_MS) event.preventDefault()
      }}
      title={request.title}
      description={request.description}
      className="max-w-md"
      footer={<ConfirmActions cancelLabel={cancelLabel} confirmLabel={request.confirmLabel} danger={request.danger} onAnswer={ignoreEarlyYes(onAnswer, openedAt)} />}
    >
      {null}
    </Dialog>
  )
}
