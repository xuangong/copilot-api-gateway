import type { UpstreamRecord } from "../../api/types"

type Provider = UpstreamRecord["provider"]

const RING: Record<Provider, string> = {
  copilot: "ring-violet-400/40",
  azure: "ring-sky-400/40",
  custom: "ring-fuchsia-400/40",
}

const BADGE_BG: Record<Provider, string> = {
  copilot: "bg-violet-500 text-white",
  azure: "bg-sky-500 text-white",
  custom: "bg-fuchsia-500 text-white",
}

const FRAME_FALLBACK: Record<Provider, string> = {
  copilot: "bg-violet-900/40 text-violet-200",
  azure: "bg-sky-900/40 text-sky-200",
  custom: "bg-fuchsia-900/40 text-fuchsia-200",
}

const LETTER: Record<Provider, string> = {
  copilot: "C",
  azure: "A",
  custom: "X",
}

const FULL_LABEL: Record<Provider, string> = {
  copilot: "Copilot",
  azure: "Azure",
  custom: "Custom",
}

interface Props {
  provider: Provider
  avatarUrl?: string | null
  title?: string
}

export function ProviderAvatar({ provider, avatarUrl, title }: Props) {
  return (
    <div className="relative shrink-0" title={title ?? FULL_LABEL[provider]}>
      <div className={`w-10 h-10 rounded-lg ring-1 ${RING[provider]} overflow-hidden bg-surface-800 flex items-center justify-center`}>
        {avatarUrl ? (
          <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className={`w-full h-full flex items-center justify-center text-sm font-semibold ${FRAME_FALLBACK[provider]}`}>
            {LETTER[provider]}
          </span>
        )}
      </div>
      <span
        className={`absolute -bottom-1.5 -right-2 text-[10px] font-semibold uppercase tracking-wide leading-none px-1.5 py-0.5 rounded-md shadow ring-1 ring-black/20 ${BADGE_BG[provider]}`}
      >
        {FULL_LABEL[provider]}
      </span>
    </div>
  )
}
