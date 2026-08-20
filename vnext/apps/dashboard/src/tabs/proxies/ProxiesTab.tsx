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
  testProxy,
  type ProxyRecord,
  type ProxyBackoffRow,
  type ProxyTestAnchor,
  type ProxyTestResult,
} from "../../api/proxies"
import { ProxyForm } from "./ProxyForm"
import {
  type ProxyDraft,
  defaultsFor,
  draftIsValid,
  draftUrl,
  parseProxyUriSafe,
} from "./proxy-form-config"

/**
 * Hide the credential in the URL so a screen-share does not leak it. The
 * route is admin-only and `GET /api/proxies` returns the real URL — this is a
 * shoulder-surfing guard, not API redaction.
 */
function maskUrl(url: string): string {
  return url.replace(/\/\/([^@/]+)@/, "//••••@")
}

const ANCHORS: ProxyTestAnchor[] = ["ipify", "aws", "ident.me-v6"]

const EMPTY_DRAFT: ProxyDraft = {
  name: "",
  // 新建时默认落在 trojan —— 这是本部署里最常用的形态。
  config: defaultsFor("trojan", { host: "", port: 443, name: "" }),
  url: null,
  dialTimeoutSeconds: "",
}

export function ProxiesTab() {
  const t = useT()
  const { push: toast } = useToast()
  const [rows, setRows] = useState<ProxyRecord[]>([])
  const [backoffs, setBackoffs] = useState<ProxyBackoffRow[]>([])
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ProxyDraft>(EMPTY_DRAFT)
  const [creating, setCreating] = useState(false)
  const [anchor, setAnchor] = useState<ProxyTestAnchor>("ipify")
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null)

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
    setTestResult(null)
    const parsed = parseProxyUriSafe(p.url)
    setDraft({
      name: p.name,
      // 存量行的 URL 理应都能解析（写入时 POST/PATCH 校验过），但历史数据
      // 或手工改库可能留下解析不了的行 —— 那种情况退回纯 URL 编辑模式，
      // 让管理员至少能看到并修正它，而不是被空表单挡住。
      config: parsed ?? EMPTY_DRAFT.config,
      url: parsed ? null : p.url,
      dialTimeoutSeconds: p.dialTimeoutSeconds == null ? "" : String(p.dialTimeoutSeconds),
    })
  }

  const closeForm = () => {
    setCreating(false)
    setEditingId(null)
    setDraft(EMPTY_DRAFT)
    setTestResult(null)
  }

  const submit = async () => {
    const secs = draft.dialTimeoutSeconds.trim()
    const body = {
      name: draft.name.trim(),
      url: draftUrl(draft).trim(),
      dialTimeoutSeconds: secs ? Number(secs) : null,
    }
    try {
      if (editingId) await patchProxy(editingId, body)
      else await createProxy(body)
      closeForm()
      await reload()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    }
  }

  const runTest = async () => {
    const secs = draft.dialTimeoutSeconds.trim()
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(
        await testProxy({
          url: draftUrl(draft).trim(),
          dialTimeoutSeconds: secs ? Number(secs) : null,
          anchor,
        }),
      )
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
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
            setTestResult(null)
          }}
          className="btn-primary !text-xs !py-1 !px-3 shrink-0"
        >
          {t("dash.proxyNewNode")}
        </button>
      </div>

      {creating || editingId ? (
        <div className="bg-surface-900 border border-surface-600 rounded-lg p-3 space-y-2">
          <ProxyForm draft={draft} onChange={setDraft} />

          <div className="flex gap-2 items-center flex-wrap">
            <button
              onClick={submit}
              disabled={!draftIsValid(draft)}
              className="btn-primary !text-xs !py-1 !px-3 disabled:opacity-40"
            >
              {t("dash.save")}
            </button>
            <button
              onClick={runTest}
              disabled={testing || !draftIsValid(draft)}
              className="btn-ghost !text-xs !py-1 !px-3 disabled:opacity-40"
            >
              {testing ? t("dash.proxyTestRunning") : t("dash.proxyTestBtn")}
            </button>
            <select
              value={anchor}
              onChange={(e) => {
                // find() 把 string 收窄回 ProxyTestAnchor —— 守卫而非断言。
                const a = ANCHORS.find((x) => x === e.target.value)
                if (a) setAnchor(a)
              }}
              title={t("dash.proxyAnchorLabel")}
              className="bg-surface-800 border border-surface-600 rounded px-2 py-1 text-xs"
            >
              {ANCHORS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
            <button onClick={closeForm} className="btn-ghost !text-xs !py-1 !px-3">
              {t("dash.closeBtn")}
            </button>
          </div>

          {testResult ? (
            <div
              className={`text-xs font-mono break-all ${
                testResult.ok ? "text-themed" : "text-accent-red"
              }`}
            >
              {testResult.ok
                ? t("dash.proxyTestOk", { ip: testResult.egressIp })
                : t("dash.proxyTestFail", { err: testResult.error })}
            </div>
          ) : null}
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
