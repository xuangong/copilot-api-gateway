import { useCallback, useEffect, useState } from "react"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import { ApiError } from "../../api/client"
import {
  listProxies,
  listBackoffs,
  createProxy,
  patchProxy,
  deleteProxy,
  resetBackoffs,
  type ProxyRecord,
  type ProxyBackoffRow,
} from "../../api/proxies"

/**
 * Hide the credential in the URL so a screen-share does not leak it. The
 * route is admin-only and `GET /api/proxies` returns the real URL — this is a
 * shoulder-surfing guard, not API redaction.
 */
function maskUrl(url: string): string {
  return url.replace(/\/\/([^@/]+)@/, "//••••@")
}

const EMPTY_DRAFT = { name: "", url: "", dialTimeoutSeconds: "" }

export function ProxiesTab() {
  const t = useT()
  const { push: toast } = useToast()
  const [rows, setRows] = useState<ProxyRecord[]>([])
  const [backoffs, setBackoffs] = useState<ProxyBackoffRow[]>([])
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const [creating, setCreating] = useState(false)

  const reload = useCallback(async () => {
    try {
      const [p, b] = await Promise.all([listProxies(), listBackoffs()])
      setRows(p.proxies)
      setBackoffs(b.backoffs)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    }
  }, [toast])

  useEffect(() => {
    void reload()
  }, [reload])

  const startEdit = (p: ProxyRecord) => {
    setEditingId(p.id)
    setCreating(false)
    setDraft({
      name: p.name,
      url: p.url,
      dialTimeoutSeconds: p.dialTimeoutSeconds == null ? "" : String(p.dialTimeoutSeconds),
    })
  }

  const submit = async () => {
    const secs = draft.dialTimeoutSeconds.trim()
    const body = {
      name: draft.name.trim(),
      url: draft.url.trim(),
      dialTimeoutSeconds: secs ? Number(secs) : null,
    }
    try {
      if (editingId) await patchProxy(editingId, body)
      else await createProxy(body)
      setEditingId(null)
      setCreating(false)
      setDraft(EMPTY_DRAFT)
      await reload()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    }
  }

  const remove = async (p: ProxyRecord) => {
    try {
      await deleteProxy(p.id)
      await reload()
    } catch (e) {
      // 409 means the node is still referenced by an upstream fallback chain;
      // surface the referencing upstream ids so the admin knows where to look.
      if (e instanceof ApiError && e.status === 409) {
        const ids = (e.body as { upstreamIds?: string[] })?.upstreamIds ?? []
        toast(t("dash.proxyDeleteReferenced", { ids: ids.join(", ") }), "error")
        return
      }
      toast(e instanceof Error ? e.message : String(e), "error")
    }
  }

  const resetOne = async (proxyId: string) => {
    try {
      await resetBackoffs(proxyId)
      await reload()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    }
  }

  // Backoff timestamps are seconds since epoch, not milliseconds.
  const fmt = (epochSeconds: number | null) =>
    epochSeconds == null ? "—" : new Date(epochSeconds * 1000).toLocaleString()

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm text-themed-dim">{t("dash.proxiesHint")}</div>
        <button
          onClick={() => {
            setCreating(true)
            setEditingId(null)
            setDraft(EMPTY_DRAFT)
          }}
          className="btn-primary !text-xs !py-1 !px-3 shrink-0"
        >
          {t("dash.proxyNewNode")}
        </button>
      </div>

      {creating || editingId ? (
        <div className="bg-surface-900 border border-surface-600 rounded-lg p-3 space-y-2">
          <input
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder={t("dash.proxyNameLabel")}
            className="w-full text-xs !py-1.5 !px-2"
          />
          <input
            value={draft.url}
            onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
            placeholder="trojan://password@host:443"
            className="w-full text-xs font-mono !py-1.5 !px-2"
          />
          <input
            value={draft.dialTimeoutSeconds}
            onChange={(e) => setDraft((d) => ({ ...d, dialTimeoutSeconds: e.target.value }))}
            placeholder={t("dash.proxyDialTimeoutLabel")}
            inputMode="numeric"
            className="w-full text-xs !py-1.5 !px-2"
          />
          <div className="flex gap-2">
            <button onClick={submit} className="btn-primary !text-xs !py-1 !px-3">
              {t("dash.save")}
            </button>
            <button
              onClick={() => {
                setCreating(false)
                setEditingId(null)
                setDraft(EMPTY_DRAFT)
              }}
              className="btn-ghost !text-xs !py-1 !px-3"
            >
              {t("dash.closeBtn")}
            </button>
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="text-xs text-themed-dim italic">{t("dash.proxiesEmpty")}</div>
      ) : null}

      <div className="space-y-2">
        {rows.map((p) => {
          const mine = backoffs.filter((b) => b.proxyId === p.id)
          return (
            <div key={p.id} className="bg-surface-900 border border-surface-600 rounded-lg p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-themed truncate">{p.name}</div>
                  <button
                    onClick={() => setRevealed((r) => ({ ...r, [p.id]: !r[p.id] }))}
                    className="text-xs text-themed-dim font-mono truncate hover:text-themed text-left w-full"
                    title={t("dash.proxyRevealTip")}
                  >
                    {revealed[p.id] ? p.url : maskUrl(p.url)}
                  </button>
                </div>
                <span className="text-xs text-themed-dim shrink-0">
                  {p.dialTimeoutSeconds == null
                    ? t("dash.proxyDialTimeoutDefault")
                    : `${p.dialTimeoutSeconds}s`}
                </span>
                {mine.length > 0 ? (
                  <button
                    onClick={() => setExpanded((x) => ({ ...x, [p.id]: !x[p.id] }))}
                    className="btn-ghost !text-xs !py-1 !px-2"
                  >
                    {t("dash.proxyBackoffCount", { n: mine.length })}
                  </button>
                ) : null}
                <button onClick={() => startEdit(p)} className="btn-ghost !text-xs !py-1 !px-2">
                  {t("dash.edit")}
                </button>
                <button
                  onClick={() => remove(p)}
                  className="text-accent-red hover:opacity-70 text-xs px-2 py-1"
                >
                  {t("dash.delete")}
                </button>
              </div>

              {expanded[p.id] ? (
                <div className="mt-3 border-t border-surface-600 pt-2 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs text-themed-dim">{t("dash.proxyBackoffTitle")}</div>
                    <button
                      onClick={() => resetOne(p.id)}
                      className="btn-ghost !text-xs !py-1 !px-2"
                    >
                      {t("dash.proxyBackoffReset")}
                    </button>
                  </div>
                  {mine.map((b) => (
                    <div key={b.upstreamId} className="text-xs space-y-0.5">
                      <div className="font-mono text-themed">{b.upstreamId}</div>
                      <div className="text-themed-dim">
                        {t("dash.proxyBackoffFails", { n: b.failCount })} ·{" "}
                        {t("dash.proxyBackoffUntil", { at: fmt(b.expiresAt) })}
                      </div>
                      {/* `lastError` carries a `[stage]` prefix from the dialer — render it raw. */}
                      {b.lastError ? (
                        <div className="text-accent-red font-mono break-all">{b.lastError}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
