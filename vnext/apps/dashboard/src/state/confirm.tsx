import { createContext, useContext, useState, type ReactNode } from "react"
import { ConfirmDialog, type ConfirmRequest } from "../ui/confirm-dialog"
import { useT } from "./i18n"

export type { ConfirmRequest }
export type Confirm = (request: ConfirmRequest) => Promise<boolean>

/**
 * One question at a time. A new question while one is open answers the open
 * one no, so no caller is left waiting on a dialog that has gone.
 */
export function createAsker(show: (request: ConfirmRequest | null) => void): { ask: Confirm; answer: (ok: boolean) => void } {
  let pending: ((ok: boolean) => void) | null = null
  return {
    ask: (request) => {
      pending?.(false)
      return new Promise<boolean>((resolve) => {
        pending = resolve
        show(request)
      })
    },
    answer: (ok) => {
      const resolve = pending
      pending = null
      show(null)
      resolve?.(ok)
    },
  }
}

const ConfirmCtx = createContext<Confirm | null>(null)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const t = useT()
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  const [asker] = useState(() => createAsker(setRequest))
  return (
    <ConfirmCtx.Provider value={asker.ask}>
      {children}
      {request ? <ConfirmDialog request={request} cancelLabel={t("dash.cancel")} onAnswer={asker.answer} /> : null}
    </ConfirmCtx.Provider>
  )
}

/** Asks in the page's own dialog; resolves true only when the named action is chosen. */
export function useConfirm(): Confirm {
  const ask = useContext(ConfirmCtx)
  if (!ask) throw new Error("useConfirm must be used inside <ConfirmProvider>")
  return ask
}
