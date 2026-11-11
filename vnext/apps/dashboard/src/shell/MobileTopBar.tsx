import { Menu } from "lucide-react"
import { useState } from "react"
import { UserMenu } from "../components/UserMenu"
import { useT } from "../state/i18n"
import { Sheet } from "../ui/sheet"
import type { NavGroup } from "./navigation"
import { SidebarContent } from "./Sidebar"

interface Props {
  groups: NavGroup[]
  current: string
  title: string
  onSelect: (id: string) => void
}

/** Phones only: a thin bar with the page name, and the full sidebar in a drawer. */
export function MobileTopBar({ groups, current, title, onSelect }: Props) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const select = (id: string) => {
    setOpen(false)
    onSelect(id)
  }
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-panel px-2">
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={t("dash.nav.label")}
        closeLabel={t("dash.nav.closeMenu")}
        trigger={
          <button type="button" className="theme-toggle size-9" aria-label={t("dash.nav.openMenu")}>
            <Menu className="size-5" aria-hidden="true" />
          </button>
        }
      >
        <SidebarContent groups={groups} current={current} onSelect={select} collapsible={false} showAccount={false} />
      </Sheet>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{title}</span>
      <div className="w-10">
        <UserMenu onNavigate={select} canNavigateSettings={true} compact={true} />
      </div>
    </header>
  )
}
