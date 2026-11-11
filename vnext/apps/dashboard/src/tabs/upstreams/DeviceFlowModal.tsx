import { useEffect, useId, useRef, useState } from "react"
import { ArrowLeft, ChevronRight } from "lucide-react"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import * as api from "../../api/upstreams"
import type { ProxyFallbackEntry } from "../../api/types"
import { Button } from "../../ui/button"
import { CodeBlock } from "../../ui/code-block"
import { Dialog } from "../../ui/dialog"
import { Notice } from "../../ui/notice"
import { ProxyChainEditor } from "./ProxyChainEditor"

interface Props {
  onComplete: () => void
  onClose: () => void
}

type HostKind = "github.com" | "ghe"
type Step = "pick" | "device" | "paste"

export function DeviceFlowModal({ onComplete, onClose }: Props) {
  const t = useT()
  const [step, setStep] = useState<Step>("pick")
  // Lives here, not in HostPicker, so a "← Back" from either branch keeps the
  // user's selection.
  const [chain, setChain] = useState<ProxyFallbackEntry[]>([])

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
          onPick={(k) => setStep(k === "github.com" ? "device" : "paste")}
          onCancel={onClose}
        />
      ) : step === "device" ? (
        <DeviceFlowStep
          chain={chain}
          onComplete={onComplete}
          onClose={onClose}
          onBack={() => setStep("pick")}
        />
      ) : (
        <PasteTokenStep
          chain={chain}
          onComplete={onComplete}
          onClose={onClose}
          onBack={() => setStep("pick")}
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

function DeviceFlowStep({
  chain,
  onComplete,
  onClose,
  onBack,
}: {
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
        const d = await api.startGithubDeviceFlow(chain)
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
        const r = await api.pollGithubDeviceFlow(deviceCode, chain)
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

function PasteTokenStep({
  chain,
  onComplete,
  onClose,
  onBack,
}: {
  chain: ProxyFallbackEntry[]
  onComplete: () => void
  onClose: () => void
  onBack: () => void
}) {
  const { push: toast } = useToast()
  const t = useT()
  const [host, setHost] = useState("")
  const [token, setToken] = useState("")
  const [pending, setPending] = useState(false)
  const hostId = useId()
  const tokenId = useId()

  const cmd = `bun run vnext/tools/extract-vscode-github-token.ts --host ${host || "your-company.ghe.com"}`

  async function submit() {
    if (!host.trim() || !token.trim()) return
    setPending(true)
    try {
      const r = await api.pasteGithubToken(token.trim(), host.trim(), chain)
      if (r.status === "complete") {
        toast(t("dash.pasteTokenSuccess"), "success")
        onComplete()
      } else {
        toast(r.error || t("dash.pasteTokenFailed"), "error")
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-subtle">{t("dash.pasteTokenSubtitle")}</p>

      <div>
        <label htmlFor={hostId} className="mb-1 block text-xs text-fg-muted">{t("dash.gheHostLabel")}</label>
        <input
          id={hostId}
          type="text"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder={t("dash.gheHostPlaceholder")}
          autoFocus
        />
      </div>

      <details className={detailsCls}>
        <summary className={summaryCls}>
          <ChevronRight className={chevronCls} aria-hidden="true" />
          {t("dash.pasteTokenHelp")}
        </summary>
        <div className="mt-2 space-y-2">
          <div className="text-xs text-fg-subtle">{t("dash.pasteTokenHelpSteps")}</div>
          <CodeBlock
            language="bash"
            text={cmd}
            copyLabel="copy"
            copied={false}
            onCopy={() => {
              navigator.clipboard.writeText(cmd).then(
                () => toast(t("dash.codeCopiedToClipboard"), "info"),
                () => {},
              )
            }}
          />
        </div>
      </details>

      <div>
        <label htmlFor={tokenId} className="mb-1 block text-xs text-fg-muted">{t("dash.pasteTokenLabel")}</label>
        <textarea
          id={tokenId}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={t("dash.pasteTokenPlaceholder")}
          rows={3}
          className="w-full font-mono"
        />
      </div>

      <div className="flex justify-between pt-1">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={pending}>
          <ArrowLeft aria-hidden="true" />
          {t("common.back")}
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
            {t("dash.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            disabled={pending || !host.trim() || !token.trim()}
          >
            {pending ? t("dash.pasteTokenPending") : t("dash.pasteTokenBtn")}
          </Button>
        </div>
      </div>
    </div>
  )
}
