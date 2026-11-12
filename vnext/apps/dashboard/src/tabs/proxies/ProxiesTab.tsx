import { useCallback, useEffect, useReducer, useRef, useState } from "react"
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
} from "../../api/proxies"
import { Button } from "../../ui/button"
import { EmptyState } from "../../ui/empty-state"
import { Notice } from "../../ui/notice"
import { PageHeader } from "../../ui/page-header"
import { Select } from "../../ui/select"
import { ProxyForm } from "./ProxyForm"
import { initialProxyTestState, reduceProxyTestState } from "./proxy-test-state"
import {
  type ProxyDraft,
  defaultsFor,
  draftIsTestable,
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
  // Until the first list arrives, "no proxies" would be a guess.
  const [loaded, setLoaded] = useState(false)
  const [backoffs, setBackoffs] = useState<ProxyBackoffRow[]>([])
  const [revealed, setRevealed] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ProxyDraft>(EMPTY_DRAFT)
  const [creating, setCreating] = useState(false)
  const [anchor, setAnchor] = useState<ProxyTestAnchor>("ipify")
  const [testState, dispatchTest] = useReducer(reduceProxyTestState, initialProxyTestState)
  const testRevision = useRef(0)
  const nameRef = useRef<HTMLInputElement>(null)
  const formOpen = creating || editingId !== null
  const { pending: testing, result: testResult } = testState
  const invalidateTest = () => {
    dispatchTest({ type: "invalidate", revision: ++testRevision.current })
  }

  const reload = useCallback(async () => {
    try {
      const [p, b] = await Promise.all([listProxies(), listBackoffs()])
      setRows(p.proxies)
      setBackoffs(b.backoffs)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    } finally {
      setLoaded(true)
    }
  }, [toast])

  useEffect(() => {
    void reload()
  }, [reload])

  // The panel opens above the list, often far from the row's Edit button; move focus into it.
  useEffect(() => {
    if (formOpen) nameRef.current?.focus()
  }, [formOpen, editingId])

  const startEdit = (p: ProxyRecord) => {
    setEditingId(p.id)
    setCreating(false)
    invalidateTest()
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
    invalidateTest()
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
    const revision = ++testRevision.current
    dispatchTest({ type: "start", revision })
    try {
      const result = await testProxy({
        url: draftUrl(draft).trim(),
        dialTimeoutSeconds: secs ? Number(secs) : null,
        anchor,
      })
      dispatchTest({ type: "finish", revision, result })
    } catch (e) {
      dispatchTest({ type: "finish", revision, result: { ok: false, error: e instanceof Error ? e.message : String(e) } })
    }
  }

  const remove = async (p: ProxyRecord) => {
    if (!window.confirm(t("dash.proxyDeleteConfirm", { name: p.name }))) return
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
    <div>
      <PageHeader
        title={t("dash.proxies")}
        description={t("dash.proxiesHint")}
        actions={
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setCreating(true)
              setEditingId(null)
              setDraft(EMPTY_DRAFT)
              invalidateTest()
            }}
          >
            {t("dash.proxyNewNode")}
          </Button>
        }
      />

      <div className="space-y-3">
        {formOpen ? (
          <div className="space-y-3 rounded-lg border border-border bg-panel p-4">
            {/* Keyed by the node, so a password shown for one node is hidden again for the next. */}
            <ProxyForm key={editingId ?? "new"} draft={draft} nameRef={nameRef} onChange={(next) => { invalidateTest(); setDraft(next) }} />

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" size="sm" onClick={submit} disabled={!draftIsValid(draft)}>
                {t("dash.save")}
              </Button>
              <Button variant="secondary" size="sm" onClick={runTest} disabled={testing || !draftIsTestable(draft)}>
                {testing ? t("dash.proxyTestRunning") : t("dash.proxyTestBtn")}
              </Button>
              <div className="w-36" title={t("dash.proxyAnchorLabel")}>
                <Select
                  size="sm"
                  value={anchor}
                  ariaLabel={t("dash.proxyAnchorLabel")}
                  options={ANCHORS.map((a) => ({ value: a, label: a }))}
                  onChange={(v) => {
                    // find() 把 string 收窄回 ProxyTestAnchor —— 守卫而非断言。
                    const a = ANCHORS.find((x) => x === v)
                    if (a) { invalidateTest(); setAnchor(a) }
                  }}
                />
              </div>
              <Button variant="ghost" size="sm" onClick={closeForm}>
                {t("dash.closeBtn")}
              </Button>
            </div>

            {testResult ? (
              <Notice tone={testResult.ok ? "success" : "danger"} className="break-all font-mono text-xs">
                {testResult.ok
                  ? t("dash.proxyTestOk", { ip: testResult.egressIp })
                  : t("dash.proxyTestFail", { err: testResult.error })}
              </Notice>
            ) : null}
          </div>
        ) : null}

        {!loaded ? (
          <p className="text-sm text-fg-subtle">{t("dash.loadingShort")}</p>
        ) : rows.length === 0 ? (
          <EmptyState title={t("dash.proxiesEmpty")} />
        ) : null}

        <div className="space-y-2">
          {rows.map((p) => {
            const mine = backoffs.filter((b) => b.proxyId === p.id)
            const isRevealed = !!revealed[p.id]
            const isExpanded = !!expanded[p.id]
            return (
              <div key={p.id} className="rounded-lg border border-border bg-background p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-fg">{p.name}</div>
                    <button
                      type="button"
                      onClick={() => setRevealed((r) => ({ ...r, [p.id]: !r[p.id] }))}
                      aria-pressed={isRevealed}
                      className="block w-full cursor-pointer truncate rounded-sm text-left font-mono text-xs text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text"
                      title={t("dash.proxyRevealTip")}
                    >
                      {isRevealed ? p.url : maskUrl(p.url)}
                    </button>
                  </div>
                  <span className="shrink-0 text-xs text-fg-muted">
                    {p.dialTimeoutSeconds == null
                      ? t("dash.proxyDialTimeoutDefault")
                      : `${p.dialTimeoutSeconds}s`}
                  </span>
                  {mine.length > 0 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={isExpanded}
                      onClick={() => setExpanded((x) => ({ ...x, [p.id]: !x[p.id] }))}
                    >
                      {t("dash.proxyBackoffCount", { n: mine.length })}
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="sm" onClick={() => startEdit(p)}>
                    {t("dash.edit")}
                  </Button>
                  <Button variant="ghost" size="sm" className="text-danger hover:text-danger" onClick={() => remove(p)}>
                    {t("dash.delete")}
                  </Button>
                </div>

                {isExpanded ? (
                  <div className="mt-3 space-y-1.5 border-t border-border pt-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs text-fg-muted">{t("dash.proxyBackoffTitle")}</div>
                      <Button variant="secondary" size="sm" onClick={() => resetOne(p.id)}>
                        {t("dash.proxyBackoffReset")}
                      </Button>
                    </div>
                    {mine.map((b) => (
                      <div key={b.upstreamId} className="space-y-0.5 text-xs">
                        <div className="font-mono text-fg">{b.upstreamId}</div>
                        <div className="text-fg-muted">
                          {t("dash.proxyBackoffFails", { n: b.failCount })} ·{" "}
                          {t("dash.proxyBackoffUntil", { at: fmt(b.expiresAt) })}
                        </div>
                        {/* `lastError` carries a `[stage]` prefix from the dialer — render it raw. */}
                        {b.lastError ? (
                          <div className="break-all font-mono text-danger">{b.lastError}</div>
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
    </div>
  )
}
