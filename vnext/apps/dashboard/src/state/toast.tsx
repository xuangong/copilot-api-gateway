import { createContext, useCallback, useContext, useState, type ReactNode } from "react"

type ToastKind = "info" | "success" | "error"

interface Toast {
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

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id))
  }, [])

  const push = useCallback(
    (message: string, kind: ToastKind = "info") => {
      const id = nextId++
      setToasts((cur) => [...cur, { id, kind, message }])
      setTimeout(() => dismiss(id), 4000)
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
 * data-toast-host. The host is one polite live region, so each toast is read
 * once as it arrives (aria-atomic=false: not the whole stack again). Error
 * toasts deliberately carry no role=alert, which would announce them twice.
 */
export function ToastHost() {
  const { toasts, dismiss } = useToast()
  return (
    <div
      data-toast-host=""
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-auto fixed top-4 right-4 z-[60] flex flex-col gap-2"
    >
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismiss(t.id)}
          className={`max-w-md cursor-pointer rounded-md border px-4 py-2 text-left text-sm shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text ${TONES[t.kind]}`}
        >
          {t.message}
        </button>
      ))}
    </div>
  )
}
