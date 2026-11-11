import { useEffect, useId, useRef, useState } from "react"
import { mintSetup, previewSetup, revokeSetup } from "../../api/setup"
import type { SetupEffort, SetupPlatform, SetupPreview, SetupSelection } from "../../api/setup"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { Notice } from "../../ui/notice"
import { Select } from "../../ui/select"
import { SetupRequestGate, setupScope, staticSetupCommand, bindMintedLease } from "./setup-state"
import type { IssuedSetupLease } from "./setup-state"

const PLATFORM_OPTIONS = [{ value: "posix", label: "macOS / Linux" }, { value: "windows", label: "Windows / PowerShell" }]
const EFFORTS = ["low", "medium", "high", "xhigh", "max"]
const pre = "rounded-lg border border-border bg-muted p-3 font-mono text-xs leading-relaxed text-fg"

interface Props { keyId: string; client: "claude" | "codex"; origin: string; settings: { model: string | null; smallModel?: string | null; opusModel?: string | null; sonnetModel?: string | null; haikuModel?: string | null; disableArtifact?: boolean } }
export function SetupPanel({ keyId, client, origin, settings }: Props) {
  const t = useT()
  const id = useId()
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
    client, platform, settings: { model: settings.model, smallModel: settings.smallModel ?? null, opusModel: settings.opusModel ?? null, sonnetModel: settings.sonnetModel ?? null, haikuModel: settings.haikuModel ?? null, effort: effort || null, context1m, disableArtifact: settings.disableArtifact ?? false },
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
  const locked = busy || lease !== null
  return <section className="mt-5 border-t border-border pt-5" aria-label={t("dash.setupTitle")}>
    <h3 className="text-[13px] font-medium text-fg">{t("dash.setupTitle")}</h3>
    <p className="mt-2 text-xs leading-relaxed text-fg-subtle">{t("dash.setupPrerequisite")}</p>
    <p className="mt-1 text-xs leading-relaxed text-fg-subtle">{t("dash.setupTestBoundary")}</p>
    <div className="mt-4 flex flex-wrap items-center gap-4 text-xs">
      <div className="flex items-center gap-2">
        <span id={`${id}-platform`} className="text-xs font-medium text-fg-muted">{t("dash.setupPlatform")}</span>
        <div className="w-48"><Select labelledBy={`${id}-platform`} value={platform} disabled={locked} onChange={value => setPlatform(value as SetupPlatform)} options={PLATFORM_OPTIONS} /></div>
      </div>
      {client === "claude" && <>
        <div className="flex items-center gap-2">
          <span id={`${id}-effort`} className="text-xs font-medium text-fg-muted">{t("dash.setupEffort")}</span>
          <div className="w-40"><Select labelledBy={`${id}-effort`} value={effort} disabled={locked} onChange={value => setEffort(value as SetupEffort | "")} options={[{ value: "", label: t("dash.setupPreserve") }, ...EFFORTS.map(value => ({ value, label: value }))]} /></div>
        </div>
        <label className="flex items-center gap-2 text-fg-muted"><input type="checkbox" className="accent-brand" checked={context1m} disabled={locked} onChange={event => setContext1m(event.target.checked)} />{t("dash.setupContext")}</label>
      </>}
    </div>
    <div className="mt-4 flex gap-2"><Button variant="secondary" size="sm" disabled={locked} onClick={() => void loadPreview()}>{t("dash.setupPreview")}</Button>{current && !lease && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void mint()}>{t("dash.setupMint")}</Button>}</div>
    {lease && lease.scope !== scope && <Notice tone="warn" role="status" className="mt-3">{t("dash.setupSelectionChanged")}</Notice>}
    {shownPreview && <div className="mt-3 text-xs"><pre className={`${pre} overflow-auto`}>{JSON.stringify(shownPreview.redactedArtifact, null, 2)}</pre><p className="mt-2 break-all font-mono text-fg">SHA-256: {shownPreview.artifactDigest}</p><ul className="mt-2 text-fg-muted">{shownPreview.touchedKeys.map(item => <li key={item.target + item.key}>{item.target}: {item.key}</li>)}</ul></div>}
    {lease && <div className="mt-4 space-y-3">
      <p className="text-xs tabular-nums text-success">{expired ? t("dash.setupExpired") : t("dash.setupExpires", { time: new Date(lease.expiresAt).toLocaleTimeString() })}</p>
      <p className="text-xs text-fg-subtle">{t("dash.setupPaste")}</p>
      {/* The global input rule fixes width and font-family: inherit, so the wrapper sizes it and sets the mono face. */}
      {!expired && <div className="flex items-center gap-2"><div className="min-w-0 flex-1 font-mono"><input type="password" readOnly value={lease.leaseToken} aria-label={t("dash.setupToken")} autoComplete="off" /></div><Button variant="secondary" size="sm" onClick={() => void copy(lease.leaseToken)}>{t("dash.setupCopyToken")}</Button></div>}
      <pre className={`${pre} overflow-x-auto whitespace-pre-wrap break-all`}>{command}</pre>
      <div className="flex gap-2"><Button variant="secondary" size="sm" onClick={() => void copy(command)}>{t("dash.setupCopyCommand")}</Button><Button variant="danger" size="sm" disabled={busy} onClick={() => void revoke()}>{t("dash.setupRevoke")}</Button></div>
    </div>}
    <p className="mt-3 text-xs text-fg-subtle">{t("dash.setupInvalidation")}</p>
    {error && <Notice tone="danger" className="mt-3">{error}</Notice>}
    <p role="status" className="mt-2 text-xs text-fg-muted">{copyStatus}</p>
  </section>
}
