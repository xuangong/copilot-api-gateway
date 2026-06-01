import { useEffect, type ReactNode } from "react"

interface Props {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: "sm" | "md" | "lg"
}

const widthClass = { sm: "max-w-sm", md: "max-w-md", lg: "max-w-2xl" }

export function Modal({ open, onClose, title, children, footer, size = "md" }: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    document.body.style.overflow = "hidden"
    return () => {
      window.removeEventListener("keydown", onKey)
      document.body.style.overflow = ""
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={`glass-card p-4 sm:p-6 w-full max-h-[90vh] overflow-y-auto ${widthClass[size]}`}>
        {title ? <h3 className="text-themed font-semibold mb-4">{title}</h3> : null}
        {children}
        {footer ? <div className="flex justify-end gap-2 mt-6">{footer}</div> : null}
      </div>
    </div>
  )
}
