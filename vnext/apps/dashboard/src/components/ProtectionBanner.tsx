// apps/dashboard/src/components/ProtectionBanner.tsx
import { useT } from "../state/i18n"
import { useProtection } from "../state/protection"
import { Button } from "../ui/button"
import { Notice } from "../ui/notice"
import { bannerItems, type BannerItem } from "./protection-banner-model"

interface Props {
  items: readonly BannerItem[]
  onResume: (id: string) => void
  onOpen: (upstreamId: string) => void
  /** Ids whose resume is in flight: their button is disabled. */
  resuming?: ReadonlySet<string>
  /** Whether the viewer can open this item's upstream (not when it is someone else's: its id is blank). */
  canOpen: (item: BannerItem) => boolean
}

/** Shown on every page while a pause or warning is active; renders nothing otherwise. */
export function ProtectionBanner({ items, onResume, onOpen, canOpen, resuming }: Props) {
  const t = useT()
  if (items.length === 0) return null
  return (
    <div role="region" aria-label={t("dash.protBannerLabel")} className="mb-4 space-y-2">
      {items.map((item) => (
        <Notice key={item.id} tone={item.tone} role="status">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{item.text}</span>
            <span className="flex shrink-0 gap-1">
              {item.canResume ? <Button size="sm" variant="secondary" disabled={resuming?.has(item.id) === true} onClick={() => onResume(item.id)}>{t("dash.protResumeNow")}</Button> : null}
              {canOpen(item) ? <Button size="sm" variant="ghost" onClick={() => onOpen(item.upstreamId)}>{t("dash.protOpenSettings")}</Button> : null}
            </span>
          </div>
        </Notice>
      ))}
    </div>
  )
}

/** The banner wired to the store; refreshed every 60 s and after Resume. */
export function ProtectionBannerHost() {
  const t = useT()
  const store = useProtection()
  const items = bannerItems(store.pauses, t, Date.now())
  return <ProtectionBanner items={items} resuming={store.resuming} onResume={(id) => { void store.resume(id) }} onOpen={store.openUpstream} canOpen={(item) => item.upstreamId !== ""} />
}
