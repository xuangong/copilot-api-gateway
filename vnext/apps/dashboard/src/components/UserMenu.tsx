import { useEffect, useRef, useState } from "react"
import { api, ApiError } from "../api/client"
import { useAuth } from "../state/auth"
import { useToast } from "../state/toast"
import { useT } from "../state/i18n"
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
}

export function UserMenu({ onNavigate, canNavigateSettings }: Props) {
  const { session, logout } = useAuth()
  const t = useT()
  const [open, setOpen] = useState(false)
  const [sharingOpen, setSharingOpen] = useState(false)
  const [pwdOpen, setPwdOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener("mousedown", onClick)
    return () => window.removeEventListener("mousedown", onClick)
  }, [open])

  if (!session) return null
  const initial = (session.userName || session.email || "?")[0]?.toUpperCase() ?? "?"
  const isAdmin = session.isAdmin === true
  const isUser = session.isUser === true
  const hasPassword = session.hasPassword === true

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-full hover:opacity-80 transition-opacity cursor-pointer bg-transparent border-0 p-0"
      >
        {session.avatarUrl ? (
          <img src={session.avatarUrl} alt="" className="w-8 h-8 rounded-full" referrerPolicy="no-referrer" />
        ) : (
          <div className="w-8 h-8 rounded-full bg-accent-violet/20 flex items-center justify-center text-accent-violet text-xs font-medium">
            {initial}
          </div>
        )}
      </button>

      {open ? (
        <div
          className="absolute right-0 mt-2 w-56 rounded-lg shadow-lg border border-white/10 py-1 z-50"
          style={{ borderColor: "var(--border-color)", background: "var(--surface-800)" }}
        >
          <div className="px-4 py-2.5 border-b border-white/5" style={{ borderColor: "var(--border-color)" }}>
            <div className="text-sm font-medium text-themed truncate">{session.userName || ""}</div>
            <div className="text-xs text-themed-dim mt-0.5 truncate">{session.email || ""}</div>
            {isAdmin ? (
              <span className="inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] bg-accent-violet/10 text-accent-violet uppercase font-medium">
                {t("dash.adminLabel")}
              </span>
            ) : null}
          </div>

          {isAdmin && canNavigateSettings ? (
            <MenuItem
              onClick={() => {
                onNavigate("settings")
                setOpen(false)
              }}
              icon={<IconGear />}
              label={t("dash.settingsMenu")}
            />
          ) : null}

          {isUser ? (
            <MenuItem
              onClick={() => {
                setSharingOpen(true)
                setOpen(false)
              }}
              icon={<IconShare />}
              label={t("dash.mySharingLabel")}
            />
          ) : null}

          {hasPassword ? (
            <MenuItem
              onClick={() => {
                setPwdOpen(true)
                setOpen(false)
              }}
              icon={<IconLock />}
              label={t("dash.changePasswordMenu")}
            />
          ) : null}

          <button
            onClick={() => {
              setOpen(false)
              logout()
            }}
            className="w-full text-left px-4 py-2 text-sm text-accent-red/80 hover:text-accent-red hover:bg-surface-700 transition-colors cursor-pointer bg-transparent border-0"
          >
            <span className="inline-block w-4 h-4 mr-2 align-middle opacity-60">
              <IconLogout />
            </span>
            {t("dash.signOutMenu")}
          </button>
        </div>
      ) : null}

      <MySharingModal open={sharingOpen} onClose={() => setSharingOpen(false)} />
      <ChangePasswordModal open={pwdOpen} onClose={() => setPwdOpen(false)} />
    </div>
  )
}

function MenuItem({ onClick, icon, label }: { onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-4 py-2 text-sm text-themed-dim hover:text-themed hover:bg-surface-700 transition-colors cursor-pointer bg-transparent border-0"
    >
      <span className="inline-block w-4 h-4 mr-2 align-middle opacity-60">{icon}</span>
      {label}
    </button>
  )
}

function IconGear() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.36.61.86 1 1.51 1H21a2 2 0 1 1 0 4h-.09c-.65 0-1.15.39-1.51 1z" />
    </svg>
  )
}
function IconShare() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  )
}
function IconLock() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}
function IconLogout() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
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
          className="flex-1 !text-xs !py-1.5 !px-3 !rounded-lg"
          disabled={busy}
        />
        <button className="btn-primary !text-xs !py-1.5 !px-4" onClick={add} disabled={busy}>
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
                className="btn-ghost !text-xs text-accent-red hover:bg-accent-red/10"
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
            className="btn-primary !text-xs !py-1.5 !px-3"
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
            className="!text-xs !py-1.5 !px-3 w-full !rounded-lg"
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
            className="!text-xs !py-1.5 !px-3 w-full !rounded-lg"
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
            className="!text-xs !py-1.5 !px-3 w-full !rounded-lg"
            disabled={busy}
          />
        </div>
        {err ? <p className="text-xs text-accent-red">{err}</p> : null}
      </div>
    </Modal>
  )
}
