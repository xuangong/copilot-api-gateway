import { useMemo } from "react"
import { AuthProvider, useAuth } from "./state/auth"
import { ToastProvider, ToastHost } from "./state/toast"
import { useHashTab } from "./state/router"
import { Layout } from "./components/Layout"
import { PlaceholderTab } from "./components/PlaceholderTab"
import { UpstreamsTab } from "./tabs/upstreams/UpstreamsTab"
import { KeysTab } from "./tabs/keys/KeysTab"
import { UsersTab } from "./tabs/users/UsersTab"
import { SettingsTab } from "./tabs/settings/SettingsTab"
import { ClientsTab } from "./tabs/clients/ClientsTab"
import { LatencyTab } from "./tabs/latency/LatencyTab"
import { UsageTab } from "./tabs/usage/UsageTab"
import { ModelsTab } from "./tabs/models/ModelsTab"
import { useT } from "./state/i18n"

interface TabDef {
  id: string
  labelKey: string
  fallback: string
  adminOnly?: boolean
  userOk?: boolean
}

const ALL_TABS: ReadonlyArray<TabDef> = [
  { id: "upstreams", labelKey: "dash.upstream", fallback: "Upstreams", adminOnly: true },
  { id: "users", labelKey: "dash.users", fallback: "Users", adminOnly: true },
  { id: "keys", labelKey: "dash.apiKeys", fallback: "API Keys", userOk: true },
  { id: "models", labelKey: "dash.models", fallback: "Models", userOk: true },
  { id: "usage", labelKey: "dash.usage", fallback: "Usage", userOk: true },
  { id: "latency", labelKey: "dash.latency", fallback: "Latency", userOk: true },
  { id: "clients", labelKey: "dash.relays", fallback: "Clients", userOk: true },
]

const HIDDEN_FROM_NAV_TABS: ReadonlyArray<TabDef> = [
  { id: "settings", labelKey: "dash.settings", fallback: "Settings", userOk: true },
]

function Shell() {
  const { loading, session, error } = useAuth()
  const t = useT()

  const visibleTabs = useMemo(() => {
    if (!session) return []
    return ALL_TABS.filter((tab) => {
      if (session.isAdmin) return true
      if (tab.adminOnly) return false
      return true
    }).map(({ id, labelKey, fallback }) => ({ id, label: t(labelKey) || fallback }))
  }, [session, t])

  const defaultTab = visibleTabs[0]?.id ?? "keys"
  const allowedIds = useMemo(
    () => [...visibleTabs.map((t) => t.id), ...HIDDEN_FROM_NAV_TABS.map((t) => t.id)],
    [visibleTabs],
  )
  const [tab, setTab] = useHashTab(defaultTab, allowedIds)

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-themed-dim">Loading…</div>
  }
  if (error) {
    return <div className="min-h-screen flex items-center justify-center text-accent-red text-sm">{error}</div>
  }
  if (!session) return null

  return (
    <Layout tabs={visibleTabs} currentTab={tab} onTabChange={setTab}>
      <TabBody tab={tab} />
    </Layout>
  )
}

function TabBody({ tab }: { tab: string }) {
  switch (tab) {
    case "upstreams":
      return <UpstreamsTab />
    case "users":
      return <UsersTab />
    case "keys":
      return <KeysTab />
    case "models":
      return <ModelsTab />
    case "usage":
      return <UsageTab />
    case "latency":
      return <LatencyTab />
    case "clients":
      return <ClientsTab />
    case "settings":
      return <SettingsTab />
    default:
      return <PlaceholderTab title="Unknown tab" />
  }
}

export function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <Shell />
        <ToastHost />
      </ToastProvider>
    </AuthProvider>
  )
}
