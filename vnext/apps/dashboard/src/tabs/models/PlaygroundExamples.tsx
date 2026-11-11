import { Lightbulb } from "lucide-react"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { cn } from "../../ui/cn"

export interface PlaygroundExample {
  id: string
  titleKey: string
  hintKey: string
}

interface Props {
  examples: readonly PlaygroundExample[]
  /** The example last loaded, whose hint says what to look for in the result. */
  activeId: string | null
  onPick: (id: string) => void
  /** Set while the draft an example replaced can still be brought back. */
  onUndo?: () => void
  disabled?: boolean
}

/**
 * One-click scenarios for the non-chat panels. Loading one replaces the draft,
 * so the replaced draft stays one click away until the next edit.
 */
export function PlaygroundExamples({ examples, activeId, onPick, onUndo, disabled }: Props) {
  const t = useT()
  const active = examples.find((example) => example.id === activeId)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 flex-wrap text-xs">
        <span className="text-fg-subtle">{t("dash.playground.examples")}:</span>
        {examples.map((example) => {
          const isActive = example.id === activeId
          return (
            <button
              key={example.id}
              type="button"
              onClick={() => onPick(example.id)}
              disabled={disabled}
              title={t(example.hintKey)}
              aria-pressed={isActive}
              className={cn(
                "rounded-md border px-2.5 py-1 transition-colors disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text",
                isActive
                  ? "border-brand-text/40 bg-brand-text/10 text-brand-text"
                  : "border-border text-fg-muted hover:text-fg",
              )}
            >
              {t(example.titleKey)}
            </button>
          )
        })}
      </div>
      {active && (
        <div className="flex items-start gap-2 text-xs text-fg-subtle">
          <span className="flex items-start gap-1.5">
            <Lightbulb className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            <span>{t(active.hintKey)}</span>
          </span>
          {onUndo && (
            <Button variant="ghost" size="sm" className="-my-1 h-6 shrink-0 px-2 text-xs" onClick={onUndo}>
              {t("dash.playground.exampleUndo")}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
