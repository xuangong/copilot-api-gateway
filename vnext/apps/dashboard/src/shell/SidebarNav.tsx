import { useId } from "react"
import { useT } from "../state/i18n"
import { cn } from "../ui/cn"
import { Tooltip } from "../ui/tooltip"
import { isPlainLeftClick } from "./links"
import type { NavGroup, NavItem } from "./navigation"
import { useMediaQuery } from "./use-media-query"

interface Props {
  groups: NavGroup[]
  current: string
  onSelect: (id: string) => void
  /** Shrink to icons between the phone and desktop breakpoints. False inside the phone drawer. */
  collapsible: boolean
}

export function SidebarNav({ groups, current, onSelect, collapsible }: Props) {
  const t = useT()
  const baseId = useId()
  const wide = useMediaQuery("(min-width: 1024px)", true)
  const iconOnly = collapsible && !wide
  return (
    <nav aria-label={t("dash.nav.label")} className="flex flex-col gap-4">
      {groups.map((group) => {
        const labelId = `${baseId}-group-${group.id}`
        return (
          <div key={group.id} role="group" aria-labelledby={labelId}>
            <div
              id={labelId}
              className={cn("px-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-fg-subtle", iconOnly && "sr-only")}
            >
              {group.label}
            </div>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <li key={item.id}>
                  <NavLink item={item} active={item.id === current} iconOnly={iconOnly} onSelect={onSelect} />
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </nav>
  )
}

export function NavLink({ item, active, iconOnly, onSelect }: { item: NavItem; active: boolean; iconOnly: boolean; onSelect: (id: string) => void }) {
  const Icon = item.icon
  return (
    <Tooltip content={item.label} disabled={!iconOnly}>
      <a
        href={`#${item.id}`}
        aria-current={active ? "page" : undefined}
        aria-label={iconOnly ? item.label : undefined}
        onClick={(e) => {
          if (!isPlainLeftClick(e)) return
          e.preventDefault()
          onSelect(item.id)
        }}
        className={cn(
          "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text",
          active ? "bg-muted font-medium text-fg" : "text-fg-muted hover:bg-muted hover:text-fg",
          iconOnly && "justify-center px-0",
        )}
      >
        <Icon className={cn("size-4 shrink-0", active ? "text-brand" : "")} aria-hidden="true" />
        {iconOnly ? null : <span className="truncate">{item.label}</span>}
      </a>
    </Tooltip>
  )
}
