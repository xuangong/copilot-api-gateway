import { Moon, Sun } from "lucide-react"
import { AgentRemoteEntry } from "../components/AgentRemoteEntry"
import { UserMenu } from "../components/UserMenu"
import { useT } from "../state/i18n"
import { cn } from "../ui/cn"
import { Tooltip } from "../ui/tooltip"
import type { NavGroup } from "./navigation"
import { SidebarNav } from "./SidebarNav"
import { useMediaQuery } from "./use-media-query"
import { useTheme } from "./use-theme"

interface Props {
  groups: NavGroup[]
  current: string
  onSelect: (id: string) => void
  /** False inside the phone drawer, where the full labels always fit. */
  collapsible: boolean
  /** False inside the phone drawer: the top bar already carries the account menu. */
  showAccount?: boolean
  className?: string
}

export function SidebarContent({ groups, current, onSelect, collapsible, showAccount = true, className }: Props) {
  const t = useT()
  const wide = useMediaQuery("(min-width: 1024px)", true)
  const iconOnly = collapsible && !wide
  const { theme, toggle } = useTheme()
  const zh = typeof window !== "undefined" && window.__lang === "zh"
  const languageLabel = `${t("dash.nav.toggleLanguage")} (${zh ? "English" : "中文"})`

  return (
    <div className={cn("flex h-full flex-col gap-4 p-3", iconOnly && "items-stretch px-2", className)}>
      <div className={cn("flex h-8 items-center gap-2 px-2", iconOnly && "justify-center px-0")}>
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-brand text-brand-fg">
          <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        </span>
        {iconOnly ? <span className="sr-only">Copilot Gateway</span> : <span className="truncate text-sm font-semibold tracking-tight text-fg">Copilot Gateway</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <SidebarNav groups={groups} current={current} onSelect={onSelect} collapsible={collapsible} />
      </div>

      <div className="flex flex-col gap-1 border-t border-border pt-3">
        <AgentRemoteEntry active={current === "agent-remote"} iconOnly={iconOnly} onSelect={onSelect} />
        {showAccount ? <UserMenu onNavigate={onSelect} canNavigateSettings={true} compact={iconOnly} /> : null}
        <div className={cn("flex gap-1", iconOnly ? "flex-col items-center" : "px-1")}>
          <Tooltip content={t("dash.nav.toggleLanguage")} side={iconOnly ? "right" : "top"}>
            <button type="button" className="theme-toggle size-8" aria-label={languageLabel} onClick={() => window.toggleLang?.()}>
              <span className="text-xs font-semibold" aria-hidden="true">{zh ? "EN" : "中"}</span>
            </button>
          </Tooltip>
          <Tooltip content={t("dash.nav.toggleTheme")} side={iconOnly ? "right" : "top"}>
            <button type="button" className="theme-toggle size-8" aria-label={t("dash.nav.toggleTheme")} onClick={toggle}>
              {theme === "dark" ? <Sun className="size-4" aria-hidden="true" /> : <Moon className="size-4" aria-hidden="true" />}
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

/** The fixed sidebar from the tablet breakpoint up; icons only below 1024px. */
export function Sidebar(props: Omit<Props, "collapsible" | "showAccount" | "className">) {
  return (
    <aside className="w-14 shrink-0 border-r border-border bg-panel lg:w-60">
      <SidebarContent {...props} collapsible={true} />
    </aside>
  )
}
