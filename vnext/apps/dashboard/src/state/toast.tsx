import { X } from "lucide-react"
import { createContext, useCallback, useContext, useState, type ReactNode } from "react"

type ToastKind = "info" | "success" | "error"

export interface Toast {
  id: number
  kind: ToastKind
  message: string
}

interface ToastApi {
  toasts: Toast[]
  push: (message: string, kind?: ToastKind) => void
  dismiss: (id: number) => void
}

const ToastCtx = createContext<ToastApi | null>(null)

let nextId = 1

/** Success and info toasts leave on their own after this long. */
const AUTO_DISMISS_MS = 4000
/** The most toasts on screen at once. */
const MAX_TOASTS = 5

/**
 * The list once `toast` arrives. Errors stay until dismissed, since four
 * seconds is too short to read, or hear, what went wrong; so an error already
 * on screen is not stacked again (a failing auto-refresh repeats the same one).
 * Over the cap, the oldest toast that would leave on its own goes first, so a
 * burst of successes cannot push out an error nobody has read.
 */
export function withToast(list: Toast[], toast: Toast): Toast[] {
  if (toast.kind === "error" && list.some((t) => t.kind === "error" && t.message === toast.message)) return list
  if (list.length < MAX_TOASTS) return [...list, toast]
  const passing = list.findIndex((t) => t.kind !== "error")
  const evict = passing === -1 ? 0 : passing
  return [...list.slice(0, evict), ...list.slice(evict + 1), toast]
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (message: string, kind: ToastKind = "info") => {
      const toast = { id: nextId++, kind, message }
      setToasts((cur) => withToast(cur, toast))
      if (kind !== "error") setTimeout(() => dismiss(toast.id), AUTO_DISMISS_MS)
    },
    [dismiss],
  )

  return <ToastCtx.Provider value={{ toasts, push, dismiss }}>{children}</ToastCtx.Provider>
}

export function useToast(): ToastApi {
  const v = useContext(ToastCtx)
  if (!v) throw new Error("useToast must be used inside <ToastProvider>")
  return v
}

const TONES: Record<ToastKind, string> = {
  error: "border-danger/40 bg-background text-danger-text",
  success: "border-success/40 bg-background text-success-text",
  info: "border-border bg-panel text-fg",
}

/**
 * Toasts stack top-right above dialogs (z-[60]); ui/dialog ignores clicks inside
 * data-toast-host. On a phone they sit along the bottom instead: an error stays
 * until clicked, and at the top it would cover the top bar's menu meanwhile.
 * The host is one polite live region, so each toast is read once as it arrives
 * (aria-atomic=false: not the whole stack again). Error toasts deliberately
 * carry no role=alert, which would announce them twice. The X marks an error
 * as waiting to be dismissed.
 */
export function ToastHost() {
  const { toasts, dismiss } = useToast()
  return (
    <div
      data-toast-host=""
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-auto fixed inset-x-4 bottom-4 z-[60] flex flex-col gap-2 sm:inset-x-auto sm:right-4 sm:bottom-auto sm:top-4"
    >
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismiss(t.id)}
          className={`flex max-w-md cursor-pointer items-start gap-2 rounded-md border px-4 py-2 text-left text-sm shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text ${TONES[t.kind]}`}
        >
          <span className="min-w-0 flex-1">{t.message}</span>
          {t.kind === "error" ? <X className="mt-0.5 size-3.5 shrink-0 opacity-70" aria-hidden="true" /> : null}
        </button>
      ))}
    </div>
  )
}
