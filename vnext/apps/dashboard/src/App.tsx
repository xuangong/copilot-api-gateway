import { AgentRemoteTab } from "./tabs/agent-remote/AgentRemoteTab"
import { useMemo } from "react"
import { AuthProvider, useAuth } from "./state/auth"
import { ToastProvider, ToastHost } from "./state/toast"
import { useHashTab } from "./state/router"
import { UpstreamsTab } from "./tabs/upstreams/UpstreamsTab"
import { ProxiesTab } from "./tabs/proxies/ProxiesTab"
import { KeysTab } from "./tabs/keys/KeysTab"
import { UsersTab } from "./tabs/users/UsersTab"
import { SettingsTab } from "./tabs/settings/SettingsTab"
import { ClientsTab } from "./tabs/clients/ClientsTab"
import { LatencyTab } from "./tabs/latency/LatencyTab"
import { UsageTab } from "./tabs/usage/UsageTab"
import { ModelsTab } from "./tabs/models/ModelsTab"
import { PricingTab } from "./tabs/pricing/PricingTab"
import { useT } from "./state/i18n"
import { EmptyState } from "./ui/empty-state"
import { AppShell } from "./shell/AppShell"
import { allowedTabIds, buildNavGroups, DEFAULT_TAB } from "./shell/navigation"

function Shell() {
  const { loading, session, error } = useAuth()
  const t = useT()

  const groups = useMemo(() => (session ? buildNavGroups(t, { isAdmin: session.isAdmin === true }) : []), [session, t])
  const allowedIds = useMemo(() => allowedTabIds(groups), [groups])
  const [tab, setTab] = useHashTab(DEFAULT_TAB, allowedIds)
  const offNavTitles = useMemo(() => ({ "agent-remote": t("dash.remote.title"), settings: t("dash.settings") }), [t])

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-fg-subtle">Loading…</div>
  }
  if (error) {
    return <div role="alert" className="flex min-h-screen items-center justify-center text-sm text-danger">{error}</div>
  }
  if (!session) return null

  return (
    <AppShell groups={groups} current={tab} onSelect={setTab} offNavTitles={offNavTitles}>
      <TabBody tab={tab} />
    </AppShell>
  )
}

function TabBody({ tab }: { tab: string }) {
  switch (tab) {
    case "agent-remote":
      return <AgentRemoteTab />
    case "upstreams":
      return <UpstreamsTab />
    case "proxies":
      return <ProxiesTab />
    case "users":
      return <UsersTab />
    case "keys":
      return <KeysTab />
    case "models":
      return <ModelsTab />
    case "pricing":
      return <PricingTab />
    case "usage":
      return <UsageTab />
    case "latency":
      return <LatencyTab />
    case "clients":
      return <ClientsTab />
    case "settings":
      return <SettingsTab />
    default:
      return <EmptyState title="Unknown tab" />
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
