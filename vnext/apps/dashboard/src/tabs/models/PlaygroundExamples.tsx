import { useT } from "../../state/i18n"

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
        <span className="text-themed-dim">{t("dash.playground.examples")}:</span>
        {examples.map((example) => (
          <button
            key={example.id}
            onClick={() => onPick(example.id)}
            disabled={disabled}
            title={t(example.hintKey)}
            className={`px-2.5 py-1 rounded-md border transition-all disabled:opacity-50 ${
              example.id === activeId
                ? "border-accent-violet/40 bg-accent-violet/10 text-accent-violet"
                : "border-themed text-themed-secondary hover:text-themed"
            }`}
          >
            {t(example.titleKey)}
          </button>
        ))}
      </div>
      {active && (
        <div className="flex items-start gap-2 text-xs text-themed-dim">
          <span>💡 {t(active.hintKey)}</span>
          {onUndo && (
            <button onClick={onUndo} className="shrink-0 underline hover:text-themed">
              {t("dash.playground.exampleUndo")}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
