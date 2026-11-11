import type { ReactNode } from "react"
import { TooltipProvider } from "../ui/tooltip"
import { locateTab, type NavGroup } from "./navigation"
import { MobileTopBar } from "./MobileTopBar"
import { PageCrumb } from "./PageCrumb"
import { Sidebar } from "./Sidebar"
import { useMediaQuery } from "./use-media-query"

interface Props {
  groups: NavGroup[]
  current: string
  onSelect: (id: string) => void
  /** Title for the pages outside the groups, keyed by tab id. */
  offNavTitles: Record<string, string>
  children: ReactNode
}

export function AppShell({ groups, current, onSelect, offNavTitles, children }: Props) {
  const { group, page } = locateTab(groups, current)
  const title = page ?? offNavTitles[current] ?? ""
  // One navigation at a time: the phone drawer and the sidebar never coexist,
  // so ids stay unique and the drawer goes away when the window widens.
  const phone = useMediaQuery("(max-width: 767px)", false)
  return (
    <TooltipProvider>
      <div className="flex h-screen overflow-hidden bg-background text-fg">
        {phone ? null : <Sidebar groups={groups} current={current} onSelect={onSelect} />}
        <div className="flex min-w-0 flex-1 flex-col">
          {phone ? <MobileTopBar groups={groups} current={current} title={title} onSelect={onSelect} /> : null}
          {/* <main> spans the full width so its scrollbar sits at the window edge.
              The inner column is a min-h-0 flex-1 flex column, like the old
              Layout's <main>, so tabs such as the chat playground can fill the height.
              A long page overflows that column, so the column's own padding would sit
              above the overflow; the bottom gap is a last flex item instead, which
              follows the overflowing content. A stable gutter keeps the content from
              shifting between short and long pages. */}
          <main className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-6 [scrollbar-gutter:stable]">
            <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col px-4 sm:px-6">
              <PageCrumb group={group} page={page} fallback={title} />
              {children}
              <div aria-hidden="true" data-shell-bottom-gap="" className="h-6 shrink-0" />
            </div>
          </main>
        </div>
      </div>
    </TooltipProvider>
  )
}
