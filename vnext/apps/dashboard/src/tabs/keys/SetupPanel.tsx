import { useEffect, useRef, useState } from "react"
import { mintSetup, previewSetup, revokeSetup } from "../../api/setup"
import type { SetupEffort, SetupPlatform, SetupPreview, SetupSelection } from "../../api/setup"
import { useT } from "../../state/i18n"
import { SetupRequestGate, setupScope, staticSetupCommand, bindMintedLease } from "./setup-state"
import type { IssuedSetupLease } from "./setup-state"
interface Props { keyId: string; client: "claude" | "codex"; origin: string; settings: { model: string | null; smallModel?: string | null; opusModel?: string | null; sonnetModel?: string | null; haikuModel?: string | null } }
export function SetupPanel({ keyId, client, origin, settings }: Props) {
  const t = useT()
  const [platform, setPlatform] = useState<SetupPlatform>("posix")
  const [effort, setEffort] = useState<SetupEffort | "">("")
  const [context1m, setContext1m] = useState(false)
  const [preview, setPreview] = useState<{ scope: string; value: SetupPreview } | null>(null)
  const [lease, setLease] = useState<IssuedSetupLease | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [copyStatus, setCopyStatus] = useState("")
  const [now, setNow] = useState(Date.now())
  const gate = useRef(new SetupRequestGate())
  const selection: SetupSelection = client === "codex" ? { client, platform, settings: { model: settings.model } } : {
    client, platform, settings: { model: settings.model, smallModel: settings.smallModel ?? null, opusModel: settings.opusModel ?? null, sonnetModel: settings.sonnetModel ?? null, haikuModel: settings.haikuModel ?? null, effort: effort || null, context1m },
  }
  const scope = setupScope(keyId, selection)
  const current = preview?.scope === scope ? preview.value : null
  const command = staticSetupCommand(origin, lease?.selection.platform ?? platform)
  const shownPreview = lease?.preview ?? current
  useEffect(() => { gate.current.invalidate(); setPreview(null); setError("") }, [scope])
  useEffect(() => {
    const requestGate = gate.current
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => { clearInterval(timer); requestGate.invalidate() }
  }, [])
  const showError = () => setError(t("dash.setupFailure"))
  const loadPreview = async () => {
    setBusy(true); setError("")
    const ticket = gate.current.begin()
    try {
      const value = await previewSetup(keyId, selection)
      if (gate.current.accepts(ticket)) setPreview({ scope, value })
    } catch { if (gate.current.accepts(ticket)) showError() } finally { setBusy(false) }
  }
  const mint = async () => {
    if (!current) return
    setBusy(true); setError("")
    try { setLease(bindMintedLease(scope, selection, current, await mintSetup(keyId, selection, current))) } catch { showError(); setPreview(null) } finally { setBusy(false) }
  }
  const revoke = async () => {
    if (!lease) return
    setBusy(true); setError("")
    try { await revokeSetup(keyId, lease.leaseId); setLease(null); setPreview(null) } catch { showError() } finally { setBusy(false) }
  }
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setCopyStatus(t("dash.codeCopyTipCopied")) } catch { setCopyStatus(t("dash.clipboardUnavailable")) }
  }
  const expired = lease !== null && Date.parse(lease.expiresAt) <= now
  const button = "px-3 py-2 rounded-md bg-surface-600 text-xs disabled:opacity-40 hover:bg-surface-500"
  return <section className="mt-5 border-t border-white/10 pt-5" aria-label={t("dash.setupTitle")}>
    <h4 className="text-sm font-medium text-themed">{t("dash.setupTitle")}</h4>
    <p className="text-xs text-themed-dim mt-2 leading-relaxed">{t("dash.setupPrerequisite")}</p>
    <p className="text-xs text-themed-dim mt-1 leading-relaxed">{t("dash.setupTestBoundary")}</p>
    <div className="flex flex-wrap gap-4 items-center mt-4 text-xs">
      <label>{t("dash.setupPlatform")} <select className="bg-surface-800 rounded p-2 ml-2" value={platform} disabled={busy || lease !== null} onChange={event => setPlatform(event.target.value as SetupPlatform)}><option value="posix">macOS / Linux</option><option value="windows">Windows / PowerShell</option></select></label>
      {client === "claude" && <>
        <label>{t("dash.setupEffort")} <select className="bg-surface-800 rounded p-2 ml-2" value={effort} disabled={busy || lease !== null} onChange={event => setEffort(event.target.value as SetupEffort | "")}><option value="">{t("dash.setupPreserve")}</option>{["low", "medium", "high", "xhigh", "max"].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={context1m} disabled={busy || lease !== null} onChange={event => setContext1m(event.target.checked)} />{t("dash.setupContext")}</label>
      </>}
    </div>
    <div className="mt-4 flex gap-2"><button type="button" className={button} disabled={busy || lease !== null} onClick={() => void loadPreview()}>{t("dash.setupPreview")}</button>{current && !lease && <button type="button" className={button} disabled={busy} onClick={() => void mint()}>{t("dash.setupMint")}</button>}</div>
    {lease && lease.scope !== scope && <p role="status" className="text-xs text-amber-400 mt-3">{t("dash.setupSelectionChanged")}</p>}
    {shownPreview && <div className="mt-3 text-xs"><pre className="code-block p-3 rounded-lg overflow-auto">{JSON.stringify(shownPreview.redactedArtifact, null, 2)}</pre><p className="font-mono break-all mt-2">SHA-256: {shownPreview.artifactDigest}</p><ul className="text-themed-dim mt-2">{shownPreview.touchedKeys.map(item => <li key={item.target + item.key}>{item.target}: {item.key}</li>)}</ul></div>}
    {lease && <div className="mt-4 space-y-3">
      <p className="text-xs text-accent-teal">{expired ? t("dash.setupExpired") : t("dash.setupExpires", { time: new Date(lease.expiresAt).toLocaleTimeString() })}</p>
      <p className="text-xs text-themed-dim">{t("dash.setupPaste")}</p>
      {!expired && <div className="flex gap-2"><input type="password" readOnly value={lease.leaseToken} aria-label={t("dash.setupToken")} autoComplete="off" className="bg-surface-800 rounded px-3 py-2 min-w-0 flex-1 font-mono text-xs" /><button type="button" className={button} onClick={() => void copy(lease.leaseToken)}>{t("dash.setupCopyToken")}</button></div>}
      <pre className="code-block p-3 rounded-lg overflow-x-auto text-xs whitespace-pre-wrap break-all">{command}</pre>
      <div className="flex gap-2"><button type="button" className={button} onClick={() => void copy(command)}>{t("dash.setupCopyCommand")}</button><button type="button" className={button} disabled={busy} onClick={() => void revoke()}>{t("dash.setupRevoke")}</button></div>
    </div>}
    <p className="text-xs text-themed-dim mt-3">{t("dash.setupInvalidation")}</p>
    {error && <p role="alert" className="text-xs text-red-400 mt-3">{error}</p>}
    <p role="status" className="text-xs text-themed-dim mt-2">{copyStatus}</p>
  </section>
}
