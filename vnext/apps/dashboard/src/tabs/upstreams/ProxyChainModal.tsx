/**
 * Saving wrapper around the controlled ProxyChainEditor: holds the chain state
 * and owns the PATCH the editor used to do. The four props (upstreamId /
 * initialChain / onSaved / onClose) are unchanged from what the Upstreams tab
 * already passed — only its import line and element name moved.
 *
 * Despite the `Modal` name this renders as an inline expanding card inside the
 * upstream row (`<Expand>`): no overlay, no portal, no focus trap.
 */
import { useState } from "react"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import type { ProxyFallbackEntry } from "../../api/types"
import { patchUpstream } from "../../api/upstreams"
import { Button } from "../../ui/button"
import { ProxyChainEditor } from "./ProxyChainEditor"

interface Props {
  upstreamId: string
  initialChain: ProxyFallbackEntry[]
  onSaved: () => void
  onClose: () => void
}

export function ProxyChainModal({ upstreamId, initialChain, onSaved, onClose }: Props) {
  const t = useT()
  const { push: toast } = useToast()
  const [chain, setChain] = useState<ProxyFallbackEntry[]>(initialChain)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      // Single-field body: every other PATCH field follows the
      // `body.x === undefined ? existing.x` shape, so omitting them is a no-op.
      await patchUpstream(upstreamId, { proxyFallbackList: chain })
      toast(t("dash.proxyChainSaved"), "success")
      onSaved()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-panel p-4">
      <ProxyChainEditor value={chain} onChange={setChain} allowCreate />
      <div className="flex items-center gap-2 border-t border-border pt-3">
        <Button variant="primary" size="sm" onClick={save} disabled={saving}>
          {saving ? "…" : t("dash.save")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t("dash.closeBtn")}
        </Button>
      </div>
    </div>
  )
}
