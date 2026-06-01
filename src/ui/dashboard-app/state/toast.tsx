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

export function ToastHost() {
  const { toasts, dismiss } = useToast()
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2">
      {toasts.map((t) => {
        const tone =
          t.kind === "error"
            ? "bg-red-600/90 border-red-400 text-white"
            : t.kind === "success"
              ? "bg-emerald-600/90 border-emerald-400 text-white"
              : "bg-surface-800/95 border-surface-600 text-themed"
        return (
          <button
            key={t.id}
            onClick={() => dismiss(t.id)}
            className={`px-4 py-2 rounded border text-sm shadow-lg backdrop-blur cursor-pointer text-left max-w-md ${tone}`}
          >
            {t.message}
          </button>
        )
      })}
    </div>
  )
}
