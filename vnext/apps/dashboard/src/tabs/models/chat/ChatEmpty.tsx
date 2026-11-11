import { Hand, Lightbulb, type LucideIcon, Zap } from "lucide-react"
import { useT } from "../../../state/i18n"

interface Props {
  modelId: string
  /** Puts a suggested prompt into the composer. */
  onSuggest: (text: string) => void
}

const SUGGESTIONS: ReadonlyArray<{ Icon: LucideIcon; label: string; prompt: string }> = [
  { Icon: Lightbulb, label: "Explain how SSE streaming works", prompt: "Explain how SSE streaming works in 3 sentences." },
  { Icon: Zap, label: "Write a debounce function in TS", prompt: "Write a TypeScript function that debounces an async call." },
  { Icon: Hand, label: "Say hi", prompt: "Hi! Introduce yourself in one sentence." },
]

export function ChatEmpty({ modelId, onSuggest }: Props) {
  const t = useT()
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <div className="mb-1.5 text-lg font-semibold text-fg">{t("dash.playground.emptyHint")}</div>
      <div className="mb-6 font-mono text-xs text-fg-subtle">{modelId}</div>
      <div className="grid w-full max-w-[600px] grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-2.5">
        {SUGGESTIONS.map(({ Icon, label, prompt }) => (
          <button
            key={label}
            type="button"
            onClick={() => onSuggest(prompt)}
            className="flex items-center gap-2 rounded-lg border border-border bg-panel px-3.5 py-3 text-left text-[13px] text-fg-muted transition-colors hover:border-control hover:bg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text"
          >
            <Icon className="size-4 shrink-0 text-brand-text" aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}
