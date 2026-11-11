import type { LucideIcon } from "lucide-react"
import { Activity, ChartColumn, Boxes, Cable, CircleDollarSign, KeyRound, Network, RadioTower, Users } from "lucide-react"

export interface NavItem {
  /** The hash address, e.g. "usage" for #usage. */
  id: string
  label: string
  icon: LucideIcon
}

export interface NavGroup {
  id: string
  label: string
  items: NavItem[]
}

export interface NavConfigGroup {
  id: string
  label: string
  items: Array<NavItem & { adminOnly?: boolean }>
}

export interface NavViewer {
  isAdmin: boolean
}

type Translate = (key: string) => string

/** Where /dashboard lands when the address names no page. */
export const DEFAULT_TAB = "usage"

/** Pages reached from elsewhere (the account menu, the Agent Remote entry), not from the groups. */
export const OFF_NAV_TABS = ["agent-remote", "settings"] as const

// Keys are written out literally so the i18n coverage test can see them.
function navConfig(t: Translate): NavConfigGroup[] {
  return [
    {
      id: "observe",
      label: t("dash.nav.groupObserve"),
      items: [
        { id: "usage", label: t("dash.usage"), icon: ChartColumn },
        { id: "latency", label: t("dash.latency"), icon: Activity },
      ],
    },
    {
      id: "models",
      label: t("dash.nav.groupModels"),
      items: [
        { id: "models", label: t("dash.models"), icon: Boxes },
        { id: "pricing", label: t("dash.pricing"), icon: CircleDollarSign },
      ],
    },
    {
      id: "access",
      label: t("dash.nav.groupAccess"),
      items: [
        { id: "keys", label: t("dash.apiKeys"), icon: KeyRound },
        { id: "users", label: t("dash.users"), icon: Users, adminOnly: true },
      ],
    },
    {
      id: "connect",
      label: t("dash.nav.groupConnect"),
      items: [
        { id: "upstreams", label: t("dash.upstream"), icon: Cable },
        { id: "proxies", label: t("dash.proxies"), icon: Network, adminOnly: true },
        { id: "clients", label: t("dash.relays"), icon: RadioTower },
      ],
    },
  ]
}

export function filterNavGroups(config: NavConfigGroup[], viewer: NavViewer): NavGroup[] {
  return config
    .map((group) => ({
      id: group.id,
      label: group.label,
      items: group.items
        .filter((item) => viewer.isAdmin || !item.adminOnly)
        .map(({ id, label, icon }) => ({ id, label, icon })),
    }))
    .filter((group) => group.items.length > 0)
}

export function buildNavGroups(t: Translate, viewer: NavViewer): NavGroup[] {
  return filterNavGroups(navConfig(t), viewer)
}

export function allowedTabIds(groups: NavGroup[]): string[] {
  return [...groups.flatMap((g) => g.items.map((i) => i.id)), ...OFF_NAV_TABS]
}

/** The group and page names for the breadcrumb; both null for a page outside the groups. */
export function locateTab(groups: NavGroup[], tab: string): { group: string | null; page: string | null } {
  for (const group of groups) {
    const item = group.items.find((i) => i.id === tab)
    if (item) return { group: group.label, page: item.label }
  }
  return { group: null, page: null }
}
