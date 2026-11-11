import { type KeyboardEvent, type ReactNode, useRef } from "react"
import { cn } from "./cn"

export interface SegmentedOption<T extends string> {
  value: T
  /** Usually plain text; a node lets a segment carry a tag (e.g. a Badge) after its name. */
  label: ReactNode
}

interface Props<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>
  value: T
  onChange: (value: T) => void
  ariaLabel: string
  size?: "sm" | "md"
  /** Disables every segment, e.g. while a request that depends on the choice is in flight. */
  disabled?: boolean
  className?: string
}

/** The option index a key moves to: arrows step and wrap, Home/End jump to the ends; other keys return null. */
export function nextSegmentIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count
    case "Home":
      return 0
    case "End":
      return count - 1
    default:
      return null
  }
}

/** A small set of mutually exclusive choices shown side by side: a radio group with a roving tabindex. */
export function SegmentedControl<T extends string>({ options, value, onChange, ariaLabel, size = "md", disabled = false, className }: Props<T>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const selected = options.findIndex((o) => o.value === value)

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = nextSegmentIndex(index, event.key, options.length)
    if (next === null) return
    event.preventDefault()
    const option = options[next]
    if (!option) return
    onChange(option.value)
    buttons.current[next]?.focus()
  }

  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn("inline-flex items-center gap-0.5 rounded-md border border-control bg-panel p-0.5", className)}>
      {options.map((option, index) => {
        const active = option.value === value
        // With no match, the first option stays reachable by Tab.
        const tabbable = selected === -1 ? index === 0 : active
        return (
          <button
            key={option.value}
            ref={(el) => {
              buttons.current[index] = el
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={tabbable ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "whitespace-nowrap rounded-[5px] px-2.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text",
              size === "sm" ? "h-6" : "h-7",
              active ? "bg-background text-fg shadow-xs ring-1 ring-control" : "text-fg-muted hover:text-fg",
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
