import { useEffect, useState } from "react"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import type { ProxyFallbackEntry } from "../../api/types"
import { createProxy, listProxyOptions, type ProxyOption } from "../../api/proxies"
import { DIRECT_CONNECT_ID, DIRECT_FETCH_ID } from "./proxy-constants"

interface Props {
  /** Controlled chain. The parent owns persistence — this component never saves. */
  value: ProxyFallbackEntry[]
  onChange: (next: ProxyFallbackEntry[]) => void
  /**
   * Show the inline "create a proxy node" form. Off by default: POST
   * /api/proxies is admin-only, and the draft (add-account) caller may not be
   * an admin.
   */
  allowCreate?: boolean
}

export function ProxyChainEditor({ value, onChange, allowCreate = false }: Props) {
  const t = useT()
  const { push: toast } = useToast()
  const [pool, setPool] = useState<ProxyOption[]>([])
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState({ name: "", url: "", dialTimeoutSeconds: "" })

  useEffect(() => {
    let cancelled = false
    listProxyOptions()
      .then((r) => {
        if (!cancelled) setPool(r.proxies)
      })
      .catch((e) => toast(e instanceof Error ? e.message : String(e), "error"))
    return () => {
      cancelled = true
    }
  }, [])

  const options = [
    { id: DIRECT_CONNECT_ID, label: t("dash.proxyDirectConnect") },
    { id: DIRECT_FETCH_ID, label: t("dash.proxyDirectFetch") },
    ...pool.map((p) => ({ id: p.id, label: p.name })),
  ]

  // Spread the existing entry so any `colos` whitelist survives an id change —
  // the colo UI is out of scope this round but the field round-trips.
  const setAt = (i: number, id: string) =>
    onChange(value.map((e, j) => (j === i ? { ...e, id } : e)))
  const removeAt = (i: number) => onChange(value.filter((_, j) => j !== i))
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= value.length) return
    const next = [...value]
    const a = next[i]!
    const b = next[j]!
    next[i] = b
    next[j] = a
    onChange(next)
  }
  const addHop = () => onChange([...value, { id: options[0]?.id ?? DIRECT_CONNECT_ID }])

  const submitNewNode = async () => {
    if (!draft.name.trim() || !draft.url.trim()) return
    try {
      const secs = draft.dialTimeoutSeconds.trim()
      const { proxy } = await createProxy({
        name: draft.name.trim(),
        url: draft.url.trim(),
        dialTimeoutSeconds: secs ? Number(secs) : null,
      })
      setPool((p) => [...p, { id: proxy.id, name: proxy.name }])
      onChange([...value, { id: proxy.id }])
      setDraft({ name: "", url: "", dialTimeoutSeconds: "" })
      setCreating(false)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    }
  }

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-themed">{t("dash.proxyChainTitle")}</div>
      <div className="text-xs text-themed-dim">{t("dash.proxyChainHint")}</div>

      {value.length === 0 ? (
        <div className="text-xs text-themed-dim italic">{t("dash.proxyChainEmptyHint")}</div>
      ) : (
        <div className="space-y-1.5">
          {value.map((entry, i) => (
            <div key={`${entry.id}-${i}`} className="flex items-center gap-2">
              <span className="text-xs text-themed-dim w-5 text-right">{i + 1}.</span>
              <select
                value={entry.id}
                onChange={(e) => setAt(i, e.target.value)}
                className="text-xs flex-1 min-w-0 !py-1.5 !px-2"
              >
                {options.some((o) => o.id === entry.id) ? null : (
                  <option value={entry.id}>{t("dash.proxyUnknownNode", { id: entry.id })}</option>
                )}
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button
                onClick={() => move(i, -1)}
                disabled={i === 0}
                className="btn-ghost !text-xs !py-1 !px-2"
              >
                ↑
              </button>
              <button
                onClick={() => move(i, 1)}
                disabled={i === value.length - 1}
                className="btn-ghost !text-xs !py-1 !px-2"
              >
                ↓
              </button>
              <button
                onClick={() => removeAt(i)}
                className="text-accent-red hover:opacity-70 text-xs px-2 py-1"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={addHop} className="btn-ghost !text-xs !py-1 !px-2">
          {t("dash.proxyAddHop")}
        </button>
        {allowCreate ? (
          <button onClick={() => setCreating((v) => !v)} className="btn-ghost !text-xs !py-1 !px-2">
            {t("dash.proxyNewNode")}
          </button>
        ) : null}
      </div>

      {allowCreate && creating ? (
        <div className="space-y-2 border-t border-surface-600 pt-2">
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
          <button onClick={submitNewNode} className="btn-primary !text-xs !py-1 !px-3">
            {t("dash.proxyCreateNodeBtn")}
          </button>
        </div>
      ) : null}
    </div>
  )
}
