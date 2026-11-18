import { useEffect, useId, useRef, useState } from "react"
import { Info } from "lucide-react"
import { COPILOT_PRICING_URL } from "../../constants"
import { useT } from "../../state/i18n"

/** The note and its source link; split out so it renders without opening the button. */
export function CostInfoPanel({ id }: { id?: string }) {
  const t = useT()
  return (
    <div
      id={id}
      role="group"
      aria-label={t("dash.cost.infoLabel")}
      className="absolute right-0 top-full z-50 mt-1 w-56 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-panel p-2 text-left text-xs text-fg shadow-md"
    >
      <p>{t("dash.cost.info")}</p>
      <a
        href={COPILOT_PRICING_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 inline-block text-brand-text underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text"
      >
        {t("dash.cost.infoLink")}
      </a>
    </div>
  )
}

/**
 * Info button beside the cost figure. The note carries a link, so a hover
 * tooltip will not do (its content cannot be reached by keyboard or touch);
 * this is a click-to-open panel that closes on Escape or an outside press.
 * The panel anchors to the nearest positioned ancestor, not the icon, so it
 * stays inside the card when the icon sits near an edge.
 */
export function CostInfo() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const root = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      setOpen(false)
      button.current?.focus()
    }
    const onPress = (e: PointerEvent) => {
      if (e.target instanceof Node && !root.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    document.addEventListener("pointerdown", onPress)
    return () => {
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("pointerdown", onPress)
    }
  }, [open])

  return (
    <span ref={root} className="inline-flex">
      <button
        ref={button}
        type="button"
        aria-label={t("dash.cost.infoLabel")}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex cursor-help rounded-sm text-fg-subtle hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text"
      >
        <Info aria-hidden="true" className="size-3.5" />
      </button>
      {open ? (
        <CostInfoPanel id={panelId} />
      ) : null}
    </span>
  )
}
