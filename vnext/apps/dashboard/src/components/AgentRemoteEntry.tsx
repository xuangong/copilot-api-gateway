import { Bot } from "lucide-react"
import { useEffect, useState } from "react"
import { api } from "../api/client"
import { isPlainLeftClick } from "../shell/links"
import { useAuth } from "../state/auth"
import { useRemoteText } from "../tabs/agent-remote/remote-text"
import { cn } from "../ui/cn"
import { Tooltip } from "../ui/tooltip"

interface LinkProps {
  enabled: boolean
  authenticated: boolean
  active?: boolean
  iconOnly?: boolean
  /** In-app navigation, e.g. so the phone drawer can close. Without it the hash link navigates by itself. */
  onSelect?: (id: string) => void
}

export function AgentRemoteLink({ enabled, authenticated, active = false, iconOnly = false, onSelect }: LinkProps) {
  const t = useRemoteText()
  if (!enabled || !authenticated) return null
  // The page's own title, so the sidebar and the page cannot drift apart again.
  const name = t("dash.remote.title")
  return (
    <Tooltip content={name} disabled={!iconOnly}>
      <a
        href="#agent-remote"
        aria-current={active ? "page" : undefined}
        aria-label={iconOnly ? name : undefined}
        onClick={(e) => {
          if (!onSelect || !isPlainLeftClick(e)) return
          e.preventDefault()
          onSelect("agent-remote")
        }}
        className={cn(
          "flex h-8 items-center gap-2.5 rounded-md px-2 text-body transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text",
          active ? "bg-muted font-medium text-fg" : "text-fg-muted hover:bg-muted hover:text-fg",
          iconOnly && "justify-center px-0",
        )}
      >
        <Bot className={cn("size-4 shrink-0", active ? "text-brand" : "")} aria-hidden="true" />
        {iconOnly ? null : <span className="truncate">{name}</span>}
      </a>
    </Tooltip>
  )
}

export function AgentRemoteEntry({ active = false, iconOnly = false, onSelect }: { active?: boolean; iconOnly?: boolean; onSelect?: (id: string) => void }) {
  const { session } = useAuth()
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    api<{ enabled: boolean }>("/api/agent-remote/config", { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setEnabled(result.enabled === true) })
      .catch(() => { if (!controller.signal.aborted) setEnabled(false) })
    return () => controller.abort()
  }, [])
  return <AgentRemoteLink active={active} iconOnly={iconOnly} onSelect={onSelect} enabled={enabled} authenticated={session?.sessionToken?.startsWith("ses_") === true} />
}
