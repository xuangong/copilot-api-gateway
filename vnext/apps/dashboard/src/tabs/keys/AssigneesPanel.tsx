import { useState } from "react"
import { User, X } from "lucide-react"
import type { ApiKeyDetail } from "../../api/keys"
import { useT } from "../../state/i18n"
import { Badge } from "../../ui/badge"
import { Button } from "../../ui/button"
import { Card, SectionHeading } from "../../ui/card"

interface Props {
  keyRow: ApiKeyDetail
  onAssign: (email: string) => Promise<boolean>
  onUnassign: (userId: string) => Promise<boolean>
}

export function AssigneesPanel({ keyRow, onAssign, onUnassign }: Props) {
  const [email, setEmail] = useState("")
  const [sharing, setSharing] = useState(false)
  const t = useT()
  const alreadyShared = (keyRow.assignees ?? []).length > 0

  const submit = async () => {
    const trimmed = email.trim()
    if (!trimmed || !trimmed.includes("@")) return
    setSharing(true)
    try {
      const ok = await onAssign(trimmed)
      if (ok) setEmail("")
    } finally {
      setSharing(false)
    }
  }

  return (
    <Card>
      <SectionHeading>{t("dash.sharedWith")}</SectionHeading>
      <div className="mt-3 flex flex-wrap gap-2">
        {(keyRow.assignees ?? []).map((a) => (
          <Badge key={a.user_id} tone="brand" className="gap-1 pr-0">
            <User aria-hidden="true" className="size-3" />
            <span>{a.user_name || t("dash.unknown")}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onUnassign(a.user_id)}
              className="size-5 text-current hover:text-danger [&_svg]:size-3"
              aria-label={t("dash.unshareTip")}
              title={t("dash.unshareTip")}
            >
              <X />
            </Button>
          </Badge>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                submit()
              }
            }}
            aria-label={t("dash.shareEmailPlaceholderLong")}
            placeholder={alreadyShared ? t("dash.shareUnshareFirst") : t("dash.shareEmailPlaceholderLong")}
            disabled={sharing || alreadyShared}
          />
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={sharing || !email || alreadyShared}
          title={alreadyShared ? t("dash.shareUnshareFirst") : undefined}
        >
          {t("dash.share")}
        </Button>
      </div>
    </Card>
  )
}

export function SharedByOwnerPanel({ keyRow }: { keyRow: ApiKeyDetail }) {
  const t = useT()
  return (
    <Card>
      <SectionHeading>{t("dash.sharedByLabel")}</SectionHeading>
      <Badge tone="brand" className="mt-3 gap-1">
        <User aria-hidden="true" className="size-3" />
        <span>{keyRow.owner_name ?? t("dash.unknown")}</span>
      </Badge>
    </Card>
  )
}
