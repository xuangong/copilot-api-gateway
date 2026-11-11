import { ChevronsUpDown, Lock, LogOut, Settings, Share2 } from "lucide-react"
import { type RefObject, useEffect, useId, useRef, useState } from "react"
import { api, ApiError } from "../api/client"
import { useAuth } from "../state/auth"
import { useToast } from "../state/toast"
import { useT } from "../state/i18n"
import { Badge } from "../ui/badge"
import { Button } from "../ui/button"
import { cn } from "../ui/cn"
import { Dialog } from "../ui/dialog"
import { EmptyState } from "../ui/empty-state"
import { Tooltip } from "../ui/tooltip"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu"

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
  // The dialogs have no Radix trigger, so they hand focus back to the menu
  // trigger themselves. While one is opening, the menu must not also pull
  // focus back to the trigger (it would fight the dialog's focus trap).
  const triggerRef = useRef<HTMLButtonElement>(null)
  const openingDialog = useRef(false)
  const openDialog = (open: (v: boolean) => void) => {
    openingDialog.current = true
    open(true)
  }

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
      ref={triggerRef}
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
        <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-text/10 text-xs font-medium text-brand-text">
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
        <DropdownMenuContent
          side="top"
          align="start"
          onCloseAutoFocus={(event) => {
            if (openingDialog.current) event.preventDefault()
            openingDialog.current = false
          }}
        >
          <DropdownMenuLabel>
            <div className="truncate text-[13px] font-medium text-fg">{session.userName || ""}</div>
            <div className="truncate text-xs text-fg-subtle">{session.email || ""}</div>
            {isAdmin ? (
              <Badge tone="brand" className="mt-1 font-medium uppercase">
                {t("dash.adminLabel")}
              </Badge>
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
            <DropdownMenuItem onSelect={() => openDialog(setSharingOpen)}>
              <Share2 aria-hidden="true" />
              {t("dash.mySharingLabel")}
            </DropdownMenuItem>
          ) : null}
          {hasPassword ? (
            <DropdownMenuItem onSelect={() => openDialog(setPwdOpen)}>
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

      <MySharingModal open={sharingOpen} onClose={() => setSharingOpen(false)} returnFocusTo={triggerRef} />
      <ChangePasswordModal open={pwdOpen} onClose={() => setPwdOpen(false)} returnFocusTo={triggerRef} />
    </>
  )
}


interface DialogProps {
  open: boolean
  onClose: () => void
  /** The menu trigger: focus goes back to it on close. */
  returnFocusTo: RefObject<HTMLElement | null>
}

/** Radix returns focus to its own trigger; these dialogs open from a menu item, so return it to the menu trigger. */
function focusReturner(target: RefObject<HTMLElement | null>) {
  return (event: Event) => {
    const el = target.current
    if (!el?.isConnected) return
    event.preventDefault()
    el.focus()
  }
}

const labelCls = "mb-1 block text-xs font-medium text-fg-muted"

function MySharingModal({ open, onClose, returnFocusTo }: DialogProps) {
  const t = useT()
  const errId = useId()
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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      onCloseAutoFocus={focusReturner(returnFocusTo)}
      title={t("dash.sharedObservabilityTitle")}
      description={t("dash.sharedObsDescLong")}
      className="max-w-md"
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
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
              aria-label={t("dash.shareEmailPlaceholderLong")}
              aria-invalid={err ? true : undefined}
              aria-describedby={err ? errId : undefined}
              placeholder={t("dash.shareEmailPlaceholder")}
              disabled={busy}
            />
          </div>
          <Button variant="primary" size="sm" onClick={add} disabled={busy}>
            {t("dash.shareBtnShort")}
          </Button>
        </div>
        {err ? (
          <p id={errId} role="alert" className="text-xs text-danger">
            {err}
          </p>
        ) : null}
      </div>
      <div className="max-h-[300px] overflow-y-auto border-t border-border pt-3">
        {list.length === 0 ? (
          <EmptyState title={t("dash.notSharedYet")} />
        ) : (
          <ul>
            {list.map((g) => (
              <li key={g.viewerId} className="flex items-center justify-between gap-2 border-b border-border py-2 last:border-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-fg">{g.viewerName || g.viewerEmail}</div>
                  <div className="truncate text-xs text-fg-subtle">{g.viewerEmail}</div>
                  <div className="text-xs text-fg-subtle">{t("dash.grantedAtLabel", { date: g.grantedAt })}</div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-danger-text hover:bg-danger/10 hover:text-danger-text"
                  aria-label={t("dash.revokeShareAria", { name: g.viewerName || g.viewerEmail })}
                  onClick={() => revoke(g.viewerId)}
                >
                  {t("dash.revokeBtn")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  )
}

function ChangePasswordModal({ open, onClose, returnFocusTo }: DialogProps) {
  const { push } = useToast()
  const t = useT()
  const id = useId()
  const oldId = `${id}-old`
  const newId = `${id}-new`
  const confirmId = `${id}-confirm`
  const errId = `${id}-err`
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

  // The error is about the form as a whole, so every field points at it.
  const describedBy = err ? errId : undefined

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      onCloseAutoFocus={focusReturner(returnFocusTo)}
      title={t("dash.changePasswordModalTitle")}
      className="max-w-sm"
      footer={
        <>
          <Button variant="ghost" size="md" onClick={onClose} disabled={busy}>
            {t("dash.cancelBtn")}
          </Button>
          <Button variant="primary" size="md" onClick={submit} disabled={busy || !oldPwd || !newPwd || !confirmPwd}>
            {busy ? t("dash.savingShort") : t("dash.changeBtn")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label htmlFor={oldId} className={labelCls}>
            {t("dash.currentPasswordLabel")}
          </label>
          <input
            id={oldId}
            type="password"
            value={oldPwd}
            onChange={(e) => {
              setOldPwd(e.target.value)
              setErr("")
            }}
            aria-describedby={describedBy}
            disabled={busy}
          />
        </div>
        <div>
          <label htmlFor={newId} className={labelCls}>
            {t("dash.newPasswordLabel")}
          </label>
          <input
            id={newId}
            type="password"
            value={newPwd}
            onChange={(e) => {
              setNewPwd(e.target.value)
              setErr("")
            }}
            aria-describedby={describedBy}
            disabled={busy}
          />
        </div>
        <div>
          <label htmlFor={confirmId} className={labelCls}>
            {t("dash.confirmNewPasswordLabel")}
          </label>
          <input
            id={confirmId}
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
            aria-describedby={describedBy}
            disabled={busy}
          />
        </div>
        {err ? (
          <p id={errId} role="alert" className="text-xs text-danger">
            {err}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
