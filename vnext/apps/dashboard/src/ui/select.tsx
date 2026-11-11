import * as RadixSelect from "@radix-ui/react-select"
import { Check, ChevronDown } from "lucide-react"
import { useId } from "react"
import { Badge } from "./badge"
import { cn } from "./cn"

export interface SelectOption {
  value: string
  label: string
  /** A pill after the label, e.g. "shared" on a shared API key. */
  badge?: string
}

// Radix reserves the empty string for "no value", but our filters use "" for "all".
const EMPTY = "__all__"
export const toRadixValue = (value: string) => (value === "" ? EMPTY : value)
export const fromRadixValue = (value: string) => (value === EMPTY ? "" : value)

interface Props {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  /** Id of a visible label. The trigger is then named "label + current value", matching what is shown. */
  labelledBy?: string
  /** Used only when there is no visible label. */
  ariaLabel?: string
  /** Id of a hint or error that describes the trigger. */
  describedBy?: string
  placeholder?: string
  disabled?: boolean
  size?: "sm" | "md"
  className?: string
}

export function Select({ value, options, onChange, labelledBy, ariaLabel, describedBy, placeholder, disabled = false, size = "md", className }: Props) {
  const valueId = useId()
  const current = options.find((o) => o.value === value)
  // A value missing from the options (e.g. a deleted key) still shows as itself.
  const shown = current?.label ?? (value || placeholder || "")
  return (
    <RadixSelect.Root value={toRadixValue(value)} onValueChange={(v) => onChange(fromRadixValue(v))} disabled={disabled}>
      <RadixSelect.Trigger
        aria-labelledby={labelledBy ? `${labelledBy} ${valueId}` : undefined}
        aria-label={labelledBy ? undefined : ariaLabel}
        aria-describedby={describedBy}
        className={cn(
          "inline-flex w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-left text-[13px] text-fg transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text disabled:cursor-not-allowed disabled:opacity-50",
          size === "sm" ? "h-7" : "h-8",
          className,
        )}
      >
        <span id={valueId} className="flex min-w-0 items-center gap-1.5">
          <span className={cn("truncate", !current && !value && "text-fg-subtle")}>{shown}</span>
          {current?.badge ? <>{" "}<Badge>{current.badge}</Badge></> : null}
        </span>
        <ChevronDown className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        {/* position="popper" must stay: there is no RadixSelect.Value node, which item-aligned positioning needs. */}
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          collisionPadding={8}
          className="z-50 max-h-[min(var(--radix-select-content-available-height),20rem)] max-w-[min(var(--radix-select-content-available-width),28rem)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-border bg-background text-fg shadow-lg"
        >
          <RadixSelect.Viewport className="p-1">
            {options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={toRadixValue(option.value)}
                textValue={option.label}
                className="relative flex cursor-pointer select-none items-center gap-2 rounded-md py-1.5 pl-7 [&>span]:min-w-0 pr-2 text-[13px] text-fg-muted outline-none data-[highlighted]:bg-muted data-[highlighted]:text-fg data-[state=checked]:text-fg"
              >
                <RadixSelect.ItemIndicator className="absolute left-2 inline-flex">
                  <Check className="size-3.5" aria-hidden="true" />
                </RadixSelect.ItemIndicator>
                {/* The badge sits inside ItemText so it is part of the option's accessible name; textValue keeps typeahead on the label. */}
                <RadixSelect.ItemText>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{option.label}</span>
                    {option.badge ? <>{" "}<Badge>{option.badge}</Badge></> : null}
                  </span>
                </RadixSelect.ItemText>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
}
