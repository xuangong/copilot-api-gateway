import { useId, useState } from "react"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import { timeAgo, type InviteCode } from "../../api/users"
import { Badge } from "../../ui/badge"
import { Button } from "../../ui/button"
import { Card, SectionHeading } from "../../ui/card"
import { EmptyState } from "../../ui/empty-state"

interface Props {
  invites: InviteCode[]
  loading: boolean
  creating: boolean
  onCreate: (name: string) => Promise<boolean>
  onDelete: (id: string) => Promise<void>
}

export function InviteCodesPanel({ invites, loading, creating, onCreate, onDelete }: Props) {
  const { push: toast } = useToast()
  const t = useT()
  const headingId = useId()
  const [name, setName] = useState("")
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const submit = async () => {
    const ok = await onCreate(name)
    if (ok) setName("")
  }

  const copy = async (code: string, id: string) => {
    try {
      await navigator.clipboard.writeText(code)
      setCopiedId(id)
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500)
    } catch {
      toast(t("dash.copyFailedShort"), "error")
    }
  }

  return (
    <Card aria-labelledby={headingId} className="mb-4">
      <SectionHeading id={headingId} className="mb-3">
        {t("dash.inviteCodesTitle")}
      </SectionHeading>
      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <div className="min-w-0 flex-1">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit()
            }}
            placeholder={t("dash.inviteeNamePlaceholder")}
            aria-label={t("dash.inviteeNamePlaceholder")}
            className="text-sm"
          />
        </div>
        <Button variant="primary" onClick={submit} disabled={creating || !name.trim()}>
          {creating ? t("dash.creatingInviteShort") : t("dash.createInviteBtn")}
        </Button>
      </div>

      {loading && invites.length === 0 ? <p className="text-sm text-fg-muted">{t("dash.loadingShort")}</p> : null}
      {!loading && invites.length === 0 ? <EmptyState title={t("dash.noInviteCodesYet")} /> : null}

      {/* Announces the copy confirmation; the code button's own text change is not read out. */}
      <span aria-live="polite" className="sr-only">
        {copiedId ? t("dash.copiedShort") : ""}
      </span>

      {invites.length > 0 ? (
        <div className="space-y-2">
          {invites.map((inv) => {
            const used = !!inv.usedAt
            return (
              <div
                key={inv.id}
                className="flex items-center gap-3 p-3 rounded-md bg-panel border border-border overflow-x-auto whitespace-nowrap"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-sm font-medium text-fg shrink-0">{inv.name}</span>
                  {used ? (
                    <Badge tone="brand" className="shrink-0">
                      {t("dash.usedLabel")}
                    </Badge>
                  ) : (
                    <button
                      type="button"
                      onClick={() => copy(inv.code, inv.id)}
                      className="shrink-0 cursor-pointer rounded border border-brand-text/30 bg-brand-text/10 px-1.5 font-mono text-xs leading-5 text-brand-text transition-colors hover:bg-brand-text/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text"
                      title={t("dash.clickToCopy")}
                    >
                      {copiedId === inv.id ? t("dash.copiedShort") : inv.code}
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2 ml-auto shrink-0">
                  <span className="text-xs text-fg-muted">{timeAgo(inv.createdAt)}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onDelete(inv.id)}
                    aria-label={t("dash.deleteInviteAria", { name: inv.name })}
                    className="text-danger hover:bg-danger/10 hover:text-danger"
                  >
                    {t("dash.deleteLabel")}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      ) : null}
    </Card>
  )
}
