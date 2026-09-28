import { useEffect, useId, useRef, useState } from "react"
import { togglePerformanceFilter } from "../state/performance-data"

interface Option { value: string; label: string }

interface Props {
  ariaLabel: string
  value: string[]
  options: Option[]
  allLabel: string
  clearLabel: string
  onChange: (values: string[]) => void
  className?: string
}

export function MultiSelect({ ariaLabel, value, options, allLabel, clearLabel, onChange, className = "" }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const summaryId = useId()

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener("mousedown", onMouseDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mousedown", onMouseDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  const labels = value.map(selected => options.find(option => option.value === selected)?.label ?? selected)
  const summary = labels.length === 0 ? allLabel : labels.join(", ")

  return <div ref={rootRef} className={`relative ${className}`} data-select-open={open || undefined}>
    <button ref={triggerRef} type="button" aria-label={ariaLabel} aria-describedby={summaryId} aria-expanded={open} aria-controls={menuId}
      onClick={() => setOpen(current => !current)}
      className="w-full bg-surface-800 border border-white/10 text-themed-secondary rounded-md focus:border-accent-violet/50 focus:outline-none flex items-center justify-between gap-2 text-left px-2.5 py-1.5 text-xs">
      <span id={summaryId} className="truncate min-w-0">{summary}</span>
      <svg className="w-3 h-3 shrink-0 opacity-60" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
    {open && <div id={menuId} className="absolute left-0 right-0 mt-1 z-50 max-h-64 overflow-y-auto rounded-md border border-white/10 bg-surface-800 shadow-xl [scrollbar-width:thin]">
      <button type="button" onClick={() => onChange([])} disabled={value.length === 0}
        className="w-full text-left px-3 py-2 text-xs text-themed-secondary hover:bg-surface-600 disabled:opacity-40">{clearLabel}</button>
      {options.map(option => <button key={option.value} type="button" aria-pressed={value.includes(option.value)}
        onClick={() => onChange(togglePerformanceFilter(value, option.value))}
        className="w-full text-left px-3 py-2 text-xs text-themed-secondary hover:bg-surface-600 focus:bg-surface-600 flex items-center gap-2">
        <span aria-hidden="true" className={"inline-flex shrink-0 w-3.5 h-3.5 rounded-sm border items-center justify-center " + (value.includes(option.value) ? "border-accent-violet text-accent-violet" : "border-white/30")}>{value.includes(option.value) ? "✓" : ""}</span>
        <span className="truncate">{option.label}</span>
      </button>)}
    </div>}
  </div>
}
