import { useEffect, useRef, useState } from "react"
import { Modal } from "../../components/Modal"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import * as api from "../../api/upstreams"

interface Props {
  onComplete: () => void
  onClose: () => void
}

type HostKind = "github.com" | "ghe"
type Step = "pick" | "device" | "paste"

export function DeviceFlowModal({ onComplete, onClose }: Props) {
  const t = useT()
  const [step, setStep] = useState<Step>("pick")

  return (
    <Modal open onClose={onClose} title={t("dash.connectCopilotTitle")} size="sm">
      {step === "pick" ? (
        <HostPicker
          onPick={(k) => setStep(k === "github.com" ? "device" : "paste")}
          onCancel={onClose}
        />
      ) : step === "device" ? (
        <DeviceFlowStep onComplete={onComplete} onClose={onClose} onBack={() => setStep("pick")} />
      ) : (
        <PasteTokenStep onComplete={onComplete} onClose={onClose} onBack={() => setStep("pick")} />
      )}
    </Modal>
  )
}

function HostPicker({ onPick, onCancel }: { onPick: (k: HostKind) => void; onCancel: () => void }) {
  const t = useT()
  return (
    <div className="space-y-3">
      <p className="text-sm text-themed-dim">{t("dash.chooseHostSubtitle")}</p>
      <button
        onClick={() => onPick("github.com")}
        className="w-full text-left rounded border border-themed hover:border-accent-violet bg-surface-800 hover:bg-surface-700 p-3 transition-colors"
      >
        <div className="font-medium text-themed">{t("dash.hostGithubDotCom")}</div>
        <div className="text-xs text-themed-dim mt-0.5">{t("dash.hostGithubDotComDesc")}</div>
      </button>
      <button
        onClick={() => onPick("ghe")}
        className="w-full text-left rounded border border-themed hover:border-accent-violet bg-surface-800 hover:bg-surface-700 p-3 transition-colors"
      >
        <div className="font-medium text-themed">{t("dash.hostGhe")}</div>
        <div className="text-xs text-themed-dim mt-0.5">{t("dash.hostGheDesc")}</div>
      </button>
      <div className="flex justify-end pt-1">
        <button onClick={onCancel} className="btn-ghost text-sm">
          {t("dash.cancel")}
        </button>
      </div>
    </div>
  )
}

function DeviceFlowStep({
  onComplete,
  onClose,
  onBack,
}: {
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
        const d = await api.startGithubDeviceFlow()
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
        const r = await api.pollGithubDeviceFlow(deviceCode)
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
    <>
      {starting && status === "starting" ? (
        <p className="text-sm text-themed-dim">{t("dash.startingDeviceFlow")}</p>
      ) : null}
      {flow && status === "waiting" ? (
        <div className="space-y-3">
          <div>
            <div className="text-xs text-themed-dim mb-1">{t("dash.deviceFlowOneTimeCode")}</div>
            <div className="text-2xl font-mono tracking-widest text-accent-violet bg-surface-800 rounded p-3 text-center select-all">
              {flow.user_code}
            </div>
          </div>
          <div className="text-sm text-themed">
            {t("dash.openLabel")}{" "}
            <a className="text-accent-violet underline" href={flow.verification_uri} target="_blank" rel="noreferrer">
              {flow.verification_uri}
            </a>{" "}
            {t("dash.andPasteCodeAbove")}
          </div>
          <div className="text-xs text-themed-dim">{t("dash.waitingForAuth")}</div>
        </div>
      ) : null}
      {status === "error" ? <p className="text-sm text-accent-red">{t("dash.deviceFlowFailed")}</p> : null}
      <div className="flex justify-between mt-4">
        <button onClick={onBack} className="btn-ghost text-sm" disabled={status === "complete"}>
          ← {t("common.back")}
        </button>
        <button onClick={onClose} className="btn-ghost text-sm">
          {status === "complete" ? t("dash.closeBtn") : t("dash.cancel")}
        </button>
      </div>
    </>
  )
}

function PasteTokenStep({
  onComplete,
  onClose,
  onBack,
}: {
  onComplete: () => void
  onClose: () => void
  onBack: () => void
}) {
  const { push: toast } = useToast()
  const t = useT()
  const [host, setHost] = useState("")
  const [token, setToken] = useState("")
  const [pending, setPending] = useState(false)

  const cmd = `bun run vnext/tools/extract-vscode-github-token.ts --host ${host || "your-company.ghe.com"}`

  async function submit() {
    if (!host.trim() || !token.trim()) return
    setPending(true)
    try {
      const r = await api.pasteGithubToken(token.trim(), host.trim())
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
      <p className="text-sm text-themed-dim">{t("dash.pasteTokenSubtitle")}</p>

      <div>
        <label className="text-xs text-themed-dim block mb-1">{t("dash.gheHostLabel")}</label>
        <input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder={t("dash.gheHostPlaceholder")}
          className="w-full rounded bg-surface-800 border border-themed px-2 py-1.5 text-sm text-themed"
          autoFocus
        />
      </div>

      <details className="rounded border border-themed bg-surface-800/60 p-2">
        <summary className="text-xs text-themed-dim cursor-pointer select-none">{t("dash.pasteTokenHelp")}</summary>
        <div className="mt-2 space-y-2">
          <div className="text-xs text-themed-dim">{t("dash.pasteTokenHelpSteps")}</div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-[11px] font-mono bg-surface-900 rounded px-2 py-1.5 text-themed overflow-x-auto whitespace-nowrap">
              {cmd}
            </code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(cmd).then(
                  () => toast(t("dash.codeCopiedToClipboard"), "info"),
                  () => {},
                )
              }}
              className="btn-ghost text-xs"
            >
              copy
            </button>
          </div>
        </div>
      </details>

      <div>
        <label className="text-xs text-themed-dim block mb-1">{t("dash.pasteTokenLabel")}</label>
        <textarea
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={t("dash.pasteTokenPlaceholder")}
          rows={3}
          className="w-full rounded bg-surface-800 border border-themed px-2 py-1.5 text-sm font-mono text-themed"
        />
      </div>

      <div className="flex justify-between mt-4">
        <button onClick={onBack} className="btn-ghost text-sm" disabled={pending}>
          ← {t("common.back")}
        </button>
        <div className="flex gap-2">
          <button onClick={onClose} className="btn-ghost text-sm" disabled={pending}>
            {t("dash.cancel")}
          </button>
          <button
            onClick={submit}
            className="btn-primary text-sm"
            disabled={pending || !host.trim() || !token.trim()}
          >
            {pending ? t("dash.pasteTokenPending") : t("dash.pasteTokenBtn")}
          </button>
        </div>
      </div>
    </div>
  )
}
