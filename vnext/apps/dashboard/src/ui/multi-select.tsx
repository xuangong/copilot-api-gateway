import { ChevronDown } from "lucide-react"
import { useId } from "react"
import { cn } from "./cn"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu"

export interface MultiSelectOption {
  value: string
  label: string
}

export function multiSelectSummary(value: string[], options: MultiSelectOption[], allLabel: string): string {
  if (value.length === 0) return allLabel
  const labels = new Map(options.map((o) => [o.value, o.label]))
  return value.map((v) => labels.get(v) ?? v).join(", ")
}

function toggle(value: string[], item: string): string[] {
  return value.includes(item) ? value.filter((v) => v !== item) : [...value, item]
}

interface Props {
  value: string[]
  options: MultiSelectOption[]
  onChange: (value: string[]) => void
  allLabel: string
  clearLabel: string
  /** Id of a visible label. The trigger is then named "label + current summary", matching what is shown. */
  labelledBy?: string
  /** Used only when there is no visible label; the summary is then the description. */
  ariaLabel?: string
  className?: string
}

/** Pick any number of values; an empty selection means "all". The menu stays open while ticking. */
export function MultiSelect({ value, options, onChange, allLabel, clearLabel, labelledBy, ariaLabel, className }: Props) {
  const summaryId = useId()
  return (
    // Non-modal: a click on another control acts at once and the page does not scroll-lock while open.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-labelledby={labelledBy ? `${labelledBy} ${summaryId}` : undefined}
        aria-label={labelledBy ? undefined : ariaLabel}
        aria-describedby={labelledBy ? undefined : summaryId}
        className={cn(
          "inline-flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-left text-[13px] text-fg transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text",
          className,
        )}
      >
        <span id={summaryId} className="truncate min-w-0">{multiSelectSummary(value, options, allLabel)}</span>
        <ChevronDown className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
          align="start"
          // Radix names the menu after the trigger's text (the summary); point it at the field label instead.
          aria-labelledby={labelledBy}
          aria-label={labelledBy ? undefined : ariaLabel}
          className="max-h-[min(var(--radix-dropdown-menu-content-available-height),20rem)] min-w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto">
        <DropdownMenuItem disabled={value.length === 0} onSelect={(e) => { e.preventDefault(); onChange([]) }}>
          {clearLabel}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={value.includes(option.value)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={() => onChange(toggle(value, option.value))}
          >
            {option.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
