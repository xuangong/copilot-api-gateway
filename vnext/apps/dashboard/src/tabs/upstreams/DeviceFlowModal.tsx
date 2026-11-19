import { useEffect, useId, useRef, useState } from "react"
import { ArrowLeft, ChevronRight } from "lucide-react"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import * as api from "../../api/upstreams"
import type { ProxyFallbackEntry } from "../../api/types"
import { Button } from "../../ui/button"
import { Dialog } from "../../ui/dialog"
import { Notice } from "../../ui/notice"
import { ProxyChainEditor } from "./ProxyChainEditor"

interface Props {
  onComplete: () => void
  onClose: () => void
}

type HostKind = "github.com" | "ghe"
type Step = "pick" | "ghe-host" | "device"

const GITHUB_DOTCOM_HOST = "github.com"
// Mirrors normalizeGitHubHost in packages/gateway/src/shared/config/github-host.ts;
// the server re-validates, this only keeps the Continue button honest.
const GHE_TENANT_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com$/
const normalizeHost = (value: string) => value.trim().toLowerCase()

export function DeviceFlowModal({ onComplete, onClose }: Props) {
  const t = useT()
  const [step, setStep] = useState<Step>("pick")
  // Lives here, not in HostPicker, so a "← Back" from either branch keeps the
  // user's selection.
  const [chain, setChain] = useState<ProxyFallbackEntry[]>([])
  // Same reason: kept across "← Back" so a typo can be fixed without retyping.
  const [gheHost, setGheHost] = useState("")
  const [host, setHost] = useState(GITHUB_DOTCOM_HOST)

  // The parent mounts this only while open, so every close (Esc, a click
  // outside, Cancel/Close, completion) goes through onClose, the parent
  // unmounts it, and DeviceFlowStep's effect cleanup stops the polling.
  // Radix returns focus to the opener ("+ Add Copilot" or a row's Re-auth).
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={t("dash.connectCopilotTitle")}
      className="max-w-md"
    >
      {step === "pick" ? (
        <HostPicker
          chain={chain}
          onChainChange={setChain}
          onPick={(k) => {
            if (k === "github.com") {
              setHost(GITHUB_DOTCOM_HOST)
              setStep("device")
            } else {
              setStep("ghe-host")
            }
          }}
          onCancel={onClose}
        />
      ) : step === "ghe-host" ? (
        <GheHostStep
          value={gheHost}
          onChange={setGheHost}
          onContinue={(h) => {
            setHost(h)
            setStep("device")
          }}
          onClose={onClose}
          onBack={() => setStep("pick")}
        />
      ) : (
        <DeviceFlowStep
          host={host}
          chain={chain}
          onComplete={onComplete}
          onClose={onClose}
          onBack={() => setStep(host === GITHUB_DOTCOM_HOST ? "pick" : "ghe-host")}
        />
      )}
    </Dialog>
  )
}

const hostCardCls =
  "w-full rounded-lg border border-border p-3 text-left transition-colors hover:bg-muted cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text"
const detailsCls = "group rounded-lg border border-border p-2"
const summaryCls =
  "flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-xs text-fg-muted select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text [&::-webkit-details-marker]:hidden"
const chevronCls = "size-3.5 shrink-0 transition-transform group-open:rotate-90"

function HostPicker({
  chain,
  onChainChange,
  onPick,
  onCancel,
}: {
  chain: ProxyFallbackEntry[]
  onChainChange: (next: ProxyFallbackEntry[]) => void
  onPick: (k: HostKind) => void
  onCancel: () => void
}) {
  const t = useT()
  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-subtle">{t("dash.chooseHostSubtitle")}</p>
      <button type="button" onClick={() => onPick("github.com")} className={hostCardCls}>
        <div className="font-medium text-fg">{t("dash.hostGithubDotCom")}</div>
        <div className="mt-0.5 text-xs text-fg-subtle">{t("dash.hostGithubDotComDesc")}</div>
      </button>
      <button type="button" onClick={() => onPick("ghe")} className={hostCardCls}>
        <div className="font-medium text-fg">{t("dash.hostGhe")}</div>
        <div className="mt-0.5 text-xs text-fg-subtle">{t("dash.hostGheDesc")}</div>
      </button>
      <details className={detailsCls}>
        <summary className={summaryCls}>
          <ChevronRight className={chevronCls} aria-hidden="true" />
          {t("dash.egressProxyOptional")}
          {chain.length > 0 ? ` (${chain.length})` : null}
        </summary>
        <div className="mt-2 space-y-2">
          <div className="text-xs text-fg-subtle">{t("dash.egressProxyHint")}</div>
          <ProxyChainEditor value={chain} onChange={onChainChange} />
        </div>
      </details>
      <div className="flex justify-end pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("dash.cancel")}
        </Button>
      </div>
    </div>
  )
}

function GheHostStep({
  value,
  onChange,
  onContinue,
  onClose,
  onBack,
}: {
  value: string
  onChange: (next: string) => void
  onContinue: (host: string) => void
  onClose: () => void
  onBack: () => void
}) {
  const t = useT()
  const hostId = useId()
  const host = normalizeHost(value)
  const valid = GHE_TENANT_HOST.test(host)
  const showInvalid = host !== "" && !valid

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) onContinue(host)
      }}
    >
      <p className="text-sm text-fg-subtle">{t("dash.gheHostSubtitle")}</p>
      <div>
        <label htmlFor={hostId} className="mb-1 block text-xs text-fg-muted">{t("dash.gheHostLabel")}</label>
        <input
          id={hostId}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t("dash.gheHostPlaceholder")}
          aria-invalid={showInvalid || undefined}
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
        {showInvalid ? <div className="mt-1 text-xs text-danger">{t("dash.gheHostInvalid")}</div> : null}
      </div>
      <div className="flex justify-between pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          {t("common.back")}
        </Button>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t("dash.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={!valid}>
            {t("dash.gheHostContinue")}
          </Button>
        </div>
      </div>
    </form>
  )
}

function DeviceFlowStep({
  host,
  chain,
  onComplete,
  onClose,
  onBack,
}: {
  host: string
  chain: ProxyFallbackEntry[]
  onComplete: () => void
  onClose: () => void
  onBack: () => void
}) {
  const { push: toast } = useToast()
  const t = useT()
  const [starting, setStarting] = useState(true)
  const [flow, setFlow] = useState<api.DeviceFlowStart | null>(null)
  const [status, setStatus] = useState<"starting" | "waiting" | "complete" | "error">("starting")
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    cancelledRef.current = false
    setStarting(true)
    setStatus("starting")

    const start = async () => {
      try {
        const d = await api.startGithubDeviceFlow(host, chain)
        if (cancelledRef.current) return
        setFlow(d)
        setStatus("waiting")
        try {
          await navigator.clipboard.writeText(d.user_code)
          toast(t("dash.codeCopiedToClipboard"), "info")
        } catch {}
        scheduleNext(d.device_code, d.interval ?? 5)
      } catch (e) {
        if (cancelledRef.current) return
        setStatus("error")
        toast(e instanceof Error ? e.message : String(e), "error")
      } finally {
        if (!cancelledRef.current) setStarting(false)
      }
    }

    const scheduleNext = (deviceCode: string, interval: number) => {
      timerRef.current = setTimeout(() => poll(deviceCode, interval), interval * 1000)
    }

    const poll = async (deviceCode: string, interval: number) => {
      if (cancelledRef.current) return
      try {
        const r = await api.pollGithubDeviceFlow(deviceCode, host, chain)
        if (cancelledRef.current) return
        if (r.status === "complete") {
          setStatus("complete")
          toast(t("dash.githubAccountConnected"), "success")
          onComplete()
          return
        }
        if (r.status === "error") {
          setStatus("error")
          toast(t("dash.authFailedShort", { error: r.error ?? "unknown" }), "error")
          return
        }
        const nextInterval = r.status === "slow_down" ? (r.interval ?? interval) + 1 : (r.interval ?? interval)
        scheduleNext(deviceCode, nextInterval)
      } catch (e) {
        if (cancelledRef.current) return
        scheduleNext(deviceCode, interval)
        console.error("poll:", e)
      }
    }

    start()
    return () => {
      cancelledRef.current = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="space-y-3">
      {starting && status === "starting" ? (
        <Notice role="status">{t("dash.startingDeviceFlow")}</Notice>
      ) : null}
      {flow && status === "waiting" ? (
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-xs text-fg-subtle">{t("dash.deviceFlowOneTimeCode")}</div>
            <div className="select-all rounded-lg bg-muted p-3 text-center font-mono text-2xl tabular-nums tracking-widest text-brand-text">
              {flow.user_code}
            </div>
          </div>
          <div className="text-sm text-fg">
            {t("dash.openLabel")}{" "}
            <a className="text-brand-text underline" href={flow.verification_uri} target="_blank" rel="noreferrer">
              {flow.verification_uri}
            </a>{" "}
            {t("dash.andPasteCodeAbove")}
          </div>
          <Notice role="status">{t("dash.waitingForAuth")}</Notice>
        </div>
      ) : null}
      {status === "error" ? <Notice tone="danger">{t("dash.deviceFlowFailed")}</Notice> : null}
      <div className="flex justify-between pt-1">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={status === "complete"}>
          <ArrowLeft aria-hidden="true" />
          {t("common.back")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {status === "complete" ? t("dash.closeBtn") : t("dash.cancel")}
        </Button>
      </div>
    </div>
  )
}
