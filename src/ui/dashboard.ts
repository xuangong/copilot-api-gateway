// Dashboard page - combines tabs and client scripts
import { dashboardAssets } from "./dashboard/client"
import {
  renderDashboardHeader,
  renderKeysTab,
  renderLatencyTab,
  renderSettingsTab,
  renderUpstreamTab,
  renderUsageTab,
  renderUsersTab,
} from "./dashboard/tabs"
import { Layout } from "./layout"

export function DashboardPage(): string {
  return Layout({
    title: "Dashboard",
    children: `
      <div class="min-h-screen" x-data="dashboardApp()" x-init="init()">
        <div
          class="fixed top-0 left-1/4 w-[500px] h-[300px] bg-accent-cyan/3 rounded-full blur-[100px] pointer-events-none"
        >
        </div>
        <div
          class="fixed top-0 right-1/4 w-[400px] h-[250px] bg-accent-emerald/3 rounded-full blur-[100px] pointer-events-none"
        >
        </div>

        ${renderDashboardHeader()}

        <main class="max-w-6xl mx-auto px-6 py-8">
          ${renderUpstreamTab()} ${renderUsersTab()} ${renderKeysTab()} ${renderUsageTab()} ${renderLatencyTab()} ${renderSettingsTab()}
        </main>
      </div>

      ${dashboardAssets()}
    `,
  })
}
