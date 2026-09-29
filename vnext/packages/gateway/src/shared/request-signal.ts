import { AsyncLocalStorage } from "node:async_hooks"

const requestSignal = new AsyncLocalStorage<AbortSignal>()
export const getRequestSignal = (): AbortSignal | undefined => requestSignal.getStore()
export const withRequestSignal = <T>(signal: AbortSignal, run: () => T): T => requestSignal.run(signal, run)
