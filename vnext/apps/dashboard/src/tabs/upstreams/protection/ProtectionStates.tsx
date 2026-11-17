import type { BannerItem } from "../../../components/protection-banner-model"
import { useT } from "../../../state/i18n"
import { Button } from "../../../ui/button"
import { Notice } from "../../../ui/notice"

interface Props {
  items: readonly BannerItem[]
  /** Ids whose Resume request is in flight. */
  resuming: ReadonlySet<string>
  onResume: (id: string) => void
}

/** The upstream's current pauses and warnings. Resume only where the server allows it, disabled while its request runs. */
export function ProtectionStates({ items, resuming, onResume }: Props) {
  const t = useT()
  if (items.length === 0) return <p className="text-body text-fg">{t("dash.protStateNormal")}</p>
  return (
    <div role="status" className="space-y-2">
      {items.map((item) => (
        <Notice key={item.id} tone={item.tone} role="presentation">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{item.text}</span>
            {item.canResume ? (
              <Button size="sm" variant="secondary" disabled={resuming.has(item.id)} onClick={() => onResume(item.id)}>{t("dash.protResumeNow")}</Button>
            ) : null}
          </div>
        </Notice>
      ))}
    </div>
  )
}
