import { useEffect, useState } from "react"
import { api } from "../api/client"
import { useAuth } from "../state/auth"

export function AgentRemoteLink({ enabled, authenticated, active = false }: { enabled: boolean; authenticated: boolean; active?: boolean }) {
  if (!enabled || !authenticated) return null
  return <a href="#agent-remote" aria-current={active ? "page" : undefined} className={`px-3 py-1.5 sm:px-4 sm:py-2 rounded-md text-xs sm:text-sm font-medium ${active ? "bg-surface-600 text-themed" : "text-accent-violet hover:bg-surface-700"} whitespace-nowrap`}>Agent Remote</a>
}

export function AgentRemoteEntry({ active = false }: { active?: boolean }) {
  const { session } = useAuth()
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    api<{ enabled: boolean }>("/api/agent-remote/config", { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setEnabled(result.enabled === true) })
      .catch(() => { if (!controller.signal.aborted) setEnabled(false) })
    return () => controller.abort()
  }, [])
  return <AgentRemoteLink active={active} enabled={enabled} authenticated={session?.sessionToken?.startsWith("ses_") === true} />
}
