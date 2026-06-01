import { useEffect, useRef, useState } from "react"

export interface SelectOption {
  value: string
  label: string
}

interface Props {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  className?: string
  buttonClassName?: string
  placeholder?: string
  size?: "sm" | "md"
}

export function Select({
  value,
  options,
  onChange,
  className = "",
  buttonClassName,
  placeholder,
  size = "sm",
}: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    document.addEventListener("keydown", onEsc)
    return () => {
      document.removeEventListener("mousedown", handler)
      document.removeEventListener("keydown", onEsc)
    }
  }, [open])

  const current = options.find((o) => o.value === value)
  const label = current?.label ?? placeholder ?? ""
  const btnPad = size === "md" ? "px-3 py-2 text-sm" : "px-2.5 py-1.5 text-xs"
  const itemPad = size === "md" ? "px-3 py-2.5 text-sm" : "px-3 py-2 text-xs"

  const defaultBtn = `w-full bg-surface-800 border border-white/10 text-themed-secondary rounded-md focus:border-accent-violet/50 focus:outline-none flex items-center justify-between gap-2 text-left ${btnPad}`

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={buttonClassName ?? defaultBtn}
      >
        <span className="truncate">{label}</span>
        <svg className="w-3 h-3 shrink-0 opacity-60" viewBox="0 0 12 12" fill="none">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open ? (
        <div className="absolute left-0 right-0 mt-1 z-50 max-h-64 overflow-y-auto rounded-md border border-white/10 bg-surface-800 shadow-xl [scrollbar-width:thin]">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
              className={`w-full text-left hover:bg-surface-600 ${itemPad} ${
                o.value === value ? "text-accent-violet" : "text-themed-secondary"
              }`}
            >
              <span className="block truncate">{o.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
