import { useState } from "react"
import type { UpstreamRecord } from "../../api/types"
import { Badge } from "../../ui/badge"

type Provider = UpstreamRecord["provider"]

// Copilot and Codex are the first-party providers; everything else is neutral.
const BADGE_TONE: Record<Provider, "brand" | "neutral"> = {
  copilot: "brand",
  azure: "neutral",
  custom: "neutral",
  sdf: "neutral",
  codex: "brand",
  "claude-code": "neutral",
  loki: "neutral",
}

const LETTER: Record<Provider, string> = {
  copilot: "C",
  azure: "A",
  custom: "X",
  sdf: "S",
  codex: "C",
  "claude-code": "C",
  loki: "L",
}

const FULL_LABEL: Record<Provider, string> = {
  copilot: "Copilot",
  azure: "Azure",
  custom: "Custom",
  sdf: "SDF",
  codex: "Codex",
  "claude-code": "Claude Code",
  loki: "Loki",
}

interface Props {
  provider: Provider
  avatarUrl?: string | null
  title?: string
}

export function ProviderAvatar({ provider, avatarUrl, title }: Props) {
  // A GHE upstream's avatar_url points at the enterprise host, which the
  // browser usually can't reach. Remember the URL that failed so the letter
  // frame takes over instead of a broken-image icon, and so a later avatarUrl
  // still gets its own attempt.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  const showImage = !!avatarUrl && avatarUrl !== failedUrl

  return (
    <div className="relative shrink-0" title={title ?? FULL_LABEL[provider]}>
      <div className="w-10 h-10 rounded-lg ring-1 ring-border overflow-hidden bg-muted flex items-center justify-center">
        {showImage ? (
          <img
            src={avatarUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover"
            onError={() => setFailedUrl(avatarUrl)}
          />
        ) : (
          <span className="w-full h-full flex items-center justify-center text-sm font-semibold bg-muted text-fg-muted">
            {LETTER[provider]}
          </span>
        )}
      </div>
      {/* The opaque backing keeps the translucent badge readable over the avatar image. */}
      <span className="absolute -bottom-1.5 -right-2 rounded bg-panel shadow-sm">
        <Badge tone={BADGE_TONE[provider]} className="font-semibold uppercase tracking-wide leading-4">
          {FULL_LABEL[provider]}
        </Badge>
      </span>
    </div>
  )
}
