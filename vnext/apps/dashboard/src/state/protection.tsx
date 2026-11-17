// apps/dashboard/src/state/protection.tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { getActivePauses, resumePause, type ProtectionPause } from "../api/protection"
import { useT } from "./i18n"
import { createProtectionController } from "./protection-controller"
import { useToast } from "./toast"

export interface ProtectionStore {
  /** Active pauses and warnings the viewer may see. */
  pauses: readonly ProtectionPause[]
  /** Ids whose Resume request is in flight (their buttons are disabled). */
  resuming: ReadonlySet<string>
  refresh: () => Promise<void>
  /** Resumes a pause (owner action); true on success. */
  resume: (id: string) => Promise<boolean>
  /** An upstream the banner asked the Upstreams page to open at its Protection section. */
  focusUpstreamId: string | null
  openUpstream: (id: string) => void
  clearFocus: () => void
}

const EMPTY: ProtectionStore = { pauses: [], resuming: new Set(), refresh: async () => {}, resume: async () => false, focusUpstreamId: null, openUpstream: () => {}, clearFocus: () => {} }
const Ctx = createContext<ProtectionStore>(EMPTY)

/** Polls `/api/protection/active` every 60 s (while the page is visible) and after actions. Must sit inside the toast provider and after login. */
export function ProtectionProvider({ children }: { children: ReactNode }) {
  const { push: toast } = useToast()
  const t = useT()
  const [pauses, setPauses] = useState<ProtectionPause[]>([])
  const [resuming, setResuming] = useState<ReadonlySet<string>>(new Set())
  const [focusUpstreamId, setFocus] = useState<string | null>(null)
  const notify = useRef({ toast, t })
  notify.current = { toast, t }
  const controller = useMemo(() => createProtectionController({
    fetchActive: getActivePauses,
    resumePause,
    onPauses: setPauses,
    onPending: setResuming,
    onResumeResult: (ok) => notify.current.toast(notify.current.t(ok ? "dash.protResumed" : "dash.protResumeFailed"), ok ? "success" : "error"),
  }), [])
  useEffect(() => controller.start(), [controller])
  const openUpstream = useCallback((id: string) => { setFocus(id); window.location.hash = "upstreams" }, [])
  const clearFocus = useCallback(() => setFocus(null), [])
  const value = useMemo(
    () => ({ pauses, resuming, refresh: controller.refresh, resume: controller.resume, focusUpstreamId, openUpstream, clearFocus }),
    [pauses, resuming, controller, focusUpstreamId, openUpstream, clearFocus],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** Without a provider (tests, logged-out pages) the store is empty and every action is a no-op. */
export const useProtection = (): ProtectionStore => useContext(Ctx)
