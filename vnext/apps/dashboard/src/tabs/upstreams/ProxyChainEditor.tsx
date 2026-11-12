import { useEffect, useId, useRef, useState } from "react"
import { ChevronDown, ChevronUp, X } from "lucide-react"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import type { ProxyFallbackEntry } from "../../api/types"
import { createProxy, listProxyOptions, type ProxyOption } from "../../api/proxies"
import { Button } from "../../ui/button"
import { Select } from "../../ui/select"
import { DIRECT_CONNECT_ID, DIRECT_FETCH_ID } from "./proxy-constants"

interface Props {
  /**
   * Controlled chain. The parent owns chain persistence — this component never
   * PATCHes the chain. It does still POST a new proxy node to the global pool
   * when `allowCreate` is on; that is a different resource.
   */
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
  const titleId = useId()

  // `value` in this render's closure goes stale across the `await` in
  // submitNewNode, so appends there read through a ref instead. The old
  // uncontrolled editor got this for free from setChain's updater form.
  const valueRef = useRef(value)
  valueRef.current = value

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
  }, [toast])

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
      onChange([...valueRef.current, { id: proxy.id }])
      setDraft({ name: "", url: "", dialTimeoutSeconds: "" })
      setCreating(false)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h4 id={titleId} className="text-body font-medium text-fg">{t("dash.proxyChainTitle")}</h4>
        <p className="mt-1 text-xs text-fg-subtle">{t("dash.proxyChainHint")}</p>
      </div>

      {value.length === 0 ? (
        <p className="text-xs italic text-fg-subtle">{t("dash.proxyChainEmptyHint")}</p>
      ) : (
        <div role="group" aria-labelledby={titleId} className="space-y-1.5">
          {value.map((entry, i) => (
            <div key={`${entry.id}-${i}`} className="flex items-center gap-2">
              <span className="w-5 text-right text-xs tabular-nums text-fg-subtle">{i + 1}.</span>
              <div className="min-w-0 flex-1">
                <Select
                  size="sm"
                  value={entry.id}
                  onChange={(id) => setAt(i, id)}
                  ariaLabel={t("dash.proxyHopAria", { n: i + 1 })}
                  options={[
                    ...(options.some((o) => o.id === entry.id)
                      ? []
                      : [{ value: entry.id, label: t("dash.proxyUnknownNode", { id: entry.id }) }]),
                    ...options.map((o) => ({ value: o.id, label: o.label })),
                  ]}
                />
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                title={t("dash.proxyHopMoveUpAria", { n: i + 1 })}
                aria-label={t("dash.proxyHopMoveUpAria", { n: i + 1 })}
              >
                <ChevronUp aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => move(i, 1)}
                disabled={i === value.length - 1}
                title={t("dash.proxyHopMoveDownAria", { n: i + 1 })}
                aria-label={t("dash.proxyHopMoveDownAria", { n: i + 1 })}
              >
                <ChevronDown aria-hidden="true" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-danger hover:text-danger"
                onClick={() => removeAt(i)}
                title={t("dash.proxyHopRemoveAria", { n: i + 1 })}
                aria-label={t("dash.proxyHopRemoveAria", { n: i + 1 })}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={addHop}>
          {t("dash.proxyAddHop")}
        </Button>
        {allowCreate ? (
          <Button variant="secondary" size="sm" aria-expanded={creating} onClick={() => setCreating((v) => !v)}>
            {t("dash.proxyNewNode")}
          </Button>
        ) : null}
      </div>

      {allowCreate && creating ? (
        <div className="space-y-2 border-t border-border pt-2">
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder={t("dash.proxyNameLabel")}
            aria-label={t("dash.proxyNameLabel")}
          />
          <div className="font-mono">
            <input
              type="text"
              value={draft.url}
              onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
              placeholder="trojan://password@host:443"
              aria-label={t("dash.proxyNodeUrlAria")}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <input
            type="text"
            value={draft.dialTimeoutSeconds}
            onChange={(e) => setDraft((d) => ({ ...d, dialTimeoutSeconds: e.target.value }))}
            placeholder={t("dash.proxyDialTimeoutLabel")}
            aria-label={t("dash.proxyDialTimeoutLabel")}
            inputMode="numeric"
          />
          <Button variant="primary" size="sm" onClick={submitNewNode}>
            {t("dash.proxyCreateNodeBtn")}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
