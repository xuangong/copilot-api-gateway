import { useT } from "../../state/i18n"

export const remoteText = {
  "dash.remote.title": "Agent Hosts",
  "dash.remote.hint": "Your machines and Hosts shared with you.",
  "dash.remote.open": "Open controller",
  "dash.remote.refresh": "Refresh",
  "dash.remote.loading": "Loading Hosts…",
  "dash.remote.empty": "No Hosts yet. Open the controller to pair your first machine.",
  "dash.remote.online": "Online",
  "dash.remote.offline": "Offline",
  "dash.remote.owner": "Owner",
  "dash.remote.shared": "Shared with you",
  "dash.remote.manage": "Manage sharing",
  "dash.remote.close": "Close sharing",
  "dash.remote.quota": "Creation allowance used / total limit",
  "dash.remote.exhausted": "Creation limit reached. Existing sessions remain available.",
  "dash.remote.quotaHint": "This is a cumulative session creation limit. Existing sessions remain usable at the limit. Reconnecting, completing sessions or granting access again does not reset usage.",
  "dash.remote.email": "Existing user email",
  "dash.remote.limit": "Total session limit",
  "dash.remote.share": "Share Host",
  "dash.remote.save": "Save limit",
  "dash.remote.grant": "Grant again",
  "dash.remote.revoke": "Revoke",
  "dash.remote.revoked": "Revoked",
  "dash.remote.noShares": "This Host has not been shared yet.",
  "dash.remote.loadingShares": "Loading shares…",
  "dash.remote.lowerLimit": "A limit below the used count blocks new sessions and keeps existing sessions.",
  "dash.remote.reauthenticate": "Sign in again to manage sharing",
  "dash.remote.loadError": "Unable to load Hosts.",
} as const

export function useRemoteText() {
  const t = useT()
  return (key: keyof typeof remoteText) => {
    const result = t(key)
    return result === key ? remoteText[key] : result
  }
}
