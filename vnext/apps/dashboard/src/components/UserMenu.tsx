import { ChevronsUpDown, Lock, LogOut, Settings, Share2 } from "lucide-react"
import { useEffect, useState } from "react"
import { api, ApiError } from "../api/client"
import { useAuth } from "../state/auth"
import { useToast } from "../state/toast"
import { useT } from "../state/i18n"
import { cn } from "../ui/cn"
import { Tooltip } from "../ui/tooltip"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu"
import { Modal } from "./Modal"

interface SharedGrant {
  viewerId: string
  viewerEmail: string
  viewerName?: string
  grantedAt: string
}

interface Props {
  onNavigate: (tab: string) => void
  canNavigateSettings: boolean
  /** Avatar only, for the icon-width sidebar. */
  compact?: boolean
}

export function UserMenu({ onNavigate, canNavigateSettings, compact = false }: Props) {
  const { session, logout } = useAuth()
  const t = useT()
  const [sharingOpen, setSharingOpen] = useState(false)
  const [pwdOpen, setPwdOpen] = useState(false)
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null)

  if (!session) return null
  const initial = (session.userName || session.email || "?")[0]?.toUpperCase() ?? "?"
  const isAdmin = session.isAdmin === true
  const isUser = session.isUser === true
  const hasPassword = session.hasPassword === true
  const displayName = session.userName || session.email || (isAdmin ? "Admin" : "")

  // Compact shows only the avatar, so it needs a label; the full trigger is
  // named by its visible name and email. The open highlight keys on
  // aria-expanded because the Tooltip trigger overrides data-state.
  const trigger = (
    <DropdownMenuTrigger
      aria-label={compact ? t("dash.nav.account") : undefined}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md p-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text aria-expanded:bg-muted",
        compact && "justify-center",
      )}
    >
      {session.avatarUrl && session.avatarUrl !== failedAvatar ? (
        <img
          src={session.avatarUrl}
          alt=""
          className="size-7 shrink-0 rounded-full"
          referrerPolicy="no-referrer"
          onError={() => setFailedAvatar(session.avatarUrl ?? null)}
        />
      ) : (
        <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-violet/15 text-xs font-medium text-accent-violet">
          {initial}
        </span>
      )}
      {compact ? null : (
        <>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-fg">{displayName}</span>
            {session.email && session.email !== displayName ? (
              <span className="block truncate text-xs text-fg-subtle">{session.email}</span>
            ) : null}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
        </>
      )}
    </DropdownMenuTrigger>
  )

  return (
    <>
      <DropdownMenu>
        {compact ? <Tooltip content={displayName || t("dash.nav.account")}>{trigger}</Tooltip> : trigger}
        <DropdownMenuContent side="top" align="start">
          <DropdownMenuLabel>
            <div className="truncate text-[13px] font-medium text-fg">{session.userName || ""}</div>
            <div className="truncate text-xs text-fg-subtle">{session.email || ""}</div>
            {isAdmin ? (
              <span className="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium uppercase bg-accent-violet/10 text-accent-violet">
                {t("dash.adminLabel")}
              </span>
            ) : null}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {isAdmin && canNavigateSettings ? (
            <DropdownMenuItem onSelect={() => onNavigate("settings")}>
              <Settings aria-hidden="true" />
              {t("dash.settingsMenu")}
            </DropdownMenuItem>
          ) : null}
          {isUser ? (
            <DropdownMenuItem onSelect={() => setSharingOpen(true)}>
              <Share2 aria-hidden="true" />
              {t("dash.mySharingLabel")}
            </DropdownMenuItem>
          ) : null}
          {hasPassword ? (
            <DropdownMenuItem onSelect={() => setPwdOpen(true)}>
              <Lock aria-hidden="true" />
              {t("dash.changePasswordMenu")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => logout()} className="text-danger data-[highlighted]:text-danger">
            <LogOut aria-hidden="true" />
            {t("dash.signOutMenu")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <MySharingModal open={sharingOpen} onClose={() => setSharingOpen(false)} />
      <ChangePasswordModal open={pwdOpen} onClose={() => setPwdOpen(false)} />
    </>
  )
}

function MySharingModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const [email, setEmail] = useState("")
  const [list, setList] = useState<SharedGrant[]>([])
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)

  const reload = async () => {
    try {
      const r = await api<SharedGrant[]>("/api/observability-shares/granted-by-me")
      setList(Array.isArray(r) ? r : [])
    } catch {
      setList([])
    }
  }

  useEffect(() => {
    if (open) {
      setErr("")
      setEmail("")
      reload()
    }
  }, [open])

  const add = async () => {
    setErr("")
    const v = email.trim().toLowerCase()
    if (!v) {
      setErr(t("dash.enterEmail"))
      return
    }
    setBusy(true)
    try {
      await api("/api/observability-shares", { method: "POST", body: { viewerEmail: v } })
      setEmail("")
      await reload()
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 404) setErr(t("dash.noUserWithEmail"))
        else if (e.status === 400) setErr(t("dash.cannotShareSelf"))
        else setErr(e.message)
      } else {
        setErr(String(e))
      }
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (viewerId: string) => {
    try {
      await api(`/api/observability-shares/${encodeURIComponent(viewerId)}`, { method: "DELETE" })
      await reload()
    } catch {
      /* ignore */
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t("dash.sharedObservabilityTitle")} size="md">
      <p className="text-themed-dim text-xs mb-3">{t("dash.sharedObsDescLong")}</p>
      <div className="flex gap-2 mb-2">
        <input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            setErr("")
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              add()
            }
          }}
          placeholder={t("dash.shareEmailPlaceholder")}
          className="flex-1 text-xs! py-1.5! px-3! rounded-lg!"
          disabled={busy}
        />
        <button className="btn-primary text-xs! py-1.5! px-4!" onClick={add} disabled={busy}>
          {t("dash.shareBtnShort")}
        </button>
      </div>
      {err ? <div className="text-xs text-accent-red mb-2">{err}</div> : null}
      <div className="border-t border-white/5 pt-3 mt-2 max-h-[300px] overflow-y-auto">
        {list.length === 0 ? (
          <div className="text-themed-dim text-xs text-center py-4">{t("dash.notSharedYet")}</div>
        ) : (
          list.map((g) => (
            <div key={g.viewerId} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-themed truncate">{g.viewerName || g.viewerEmail}</div>
                <div className="text-[11px] text-themed-dim truncate">{g.viewerEmail}</div>
                <div className="text-[10px] text-themed-dim">{t("dash.grantedAtLabel", { date: g.grantedAt })}</div>
              </div>
              <button
                className="btn-ghost text-xs! text-accent-red hover:bg-accent-red/10"
                onClick={() => revoke(g.viewerId)}
              >
                {t("dash.revokeBtn")}
              </button>
            </div>
          ))
        )}
      </div>
    </Modal>
  )
}

function ChangePasswordModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { push } = useToast()
  const t = useT()
  const [oldPwd, setOldPwd] = useState("")
  const [newPwd, setNewPwd] = useState("")
  const [confirmPwd, setConfirmPwd] = useState("")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setOldPwd("")
      setNewPwd("")
      setConfirmPwd("")
      setErr("")
    }
  }, [open])

  const submit = async () => {
    setErr("")
    if (!oldPwd || !newPwd || !confirmPwd) {
      setErr(t("dash.allFieldsRequired"))
      return
    }
    if (newPwd.length < 6) {
      setErr(t("dash.passwordMinLenShort"))
      return
    }
    if (newPwd !== confirmPwd) {
      setErr(t("dash.passwordsDoNotMatch"))
      return
    }
    setBusy(true)
    try {
      await api("/auth/email/change-password", {
        method: "POST",
        body: { old_password: oldPwd, new_password: newPwd },
      })
      push(t("dash.passwordChangedSuccess"), "success")
      onClose()
    } catch (e) {
      if (e instanceof ApiError) {
        const lower = e.message.toLowerCase()
        if (e.status === 401 && lower.includes("incorrect")) setErr(t("dash.currentPasswordIncorrect"))
        else if (e.status === 400 && lower.includes("oauth")) setErr(t("dash.oauthNoPassword"))
        else if (e.status === 400 && lower.includes("different")) setErr(t("dash.newPasswordMustDiffer"))
        else if (e.status === 400 && lower.includes("6 characters")) setErr(t("dash.passwordMinLenShort"))
        else setErr(e.message || t("dash.failedChangePassword"))
      } else {
        setErr(t("dash.failedChangePassword"))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("dash.changePasswordModalTitle")}
      size="sm"
      footer={
        <>
          <button type="button" onClick={onClose} className="btn-ghost text-xs" disabled={busy}>
            {t("dash.cancelBtn")}
          </button>
          <button
            type="button"
            onClick={submit}
            className="btn-primary text-xs! py-1.5! px-3!"
            disabled={busy || !oldPwd || !newPwd || !confirmPwd}
          >
            {busy ? t("dash.savingShort") : t("dash.changeBtn")}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="text-xs text-themed-dim block mb-1">{t("dash.currentPasswordLabel")}</label>
          <input
            type="password"
            value={oldPwd}
            onChange={(e) => {
              setOldPwd(e.target.value)
              setErr("")
            }}
            className="text-xs! py-1.5! px-3! w-full rounded-lg!"
            disabled={busy}
          />
        </div>
        <div>
          <label className="text-xs text-themed-dim block mb-1">{t("dash.newPasswordLabel")}</label>
          <input
            type="password"
            value={newPwd}
            onChange={(e) => {
              setNewPwd(e.target.value)
              setErr("")
            }}
            className="text-xs! py-1.5! px-3! w-full rounded-lg!"
            disabled={busy}
          />
        </div>
        <div>
          <label className="text-xs text-themed-dim block mb-1">{t("dash.confirmNewPasswordLabel")}</label>
          <input
            type="password"
            value={confirmPwd}
            onChange={(e) => {
              setConfirmPwd(e.target.value)
              setErr("")
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                submit()
              }
            }}
            className="text-xs! py-1.5! px-3! w-full rounded-lg!"
            disabled={busy}
          />
        </div>
        {err ? <p className="text-xs text-accent-red">{err}</p> : null}
      </div>
    </Modal>
  )
}
