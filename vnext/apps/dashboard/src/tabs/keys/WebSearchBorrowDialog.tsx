import type { ApiKeyDetail } from "../../api/keys"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { Dialog } from "../../ui/dialog"

interface Props {
  open: boolean
  candidates: ApiKeyDetail[]
  onPick: (id: string) => void
  onClose: () => void
}

/** Pick another key whose engine key this one should link to. Esc, Cancel and the overlay all close it. */
export function WebSearchBorrowDialog({ open, candidates, onPick, onClose }: Props) {
  const t = useT()
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={t("dash.wsBorrowFromTitle")}
      className="max-w-sm"
      footer={
        <Button variant="ghost" size="md" onClick={onClose}>
          {t("dash.cancel")}
        </Button>
      }
    >
      <div className="max-h-64 space-y-1 overflow-y-auto">
        {candidates.length === 0 ? (
          <p className="text-xs text-fg-subtle">{t("dash.wsNoAvailableKeys")}</p>
        ) : (
          candidates.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onPick(c.id)}
              className="block w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text"
            >
              <span className="block text-[13px] font-medium text-fg">{c.name || c.id}</span>
              <span className="block text-xs text-fg-subtle">{c.owner_name ?? c.owner_id ?? ""}</span>
            </button>
          ))
        )}
      </div>
    </Dialog>
  )
}
