import { useEffect, useRef, useState } from "react"
import { Modal } from "../../components/Modal"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import * as api from "../../api/upstreams"

interface Props {
  onComplete: () => void
  onClose: () => void
}

export function DeviceFlowModal({ onComplete, onClose }: Props) {
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
    <Modal open onClose={onClose} title={t("dash.connectCopilotTitle")} size="sm">
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
      {status === "error" ? (
        <p className="text-sm text-accent-red">{t("dash.deviceFlowFailed")}</p>
      ) : null}
      <div className="flex justify-end mt-4">
        <button onClick={onClose} className="btn-ghost text-sm">
          {status === "complete" ? t("dash.closeBtn") : t("dash.cancel")}
        </button>
      </div>
    </Modal>
  )
}
