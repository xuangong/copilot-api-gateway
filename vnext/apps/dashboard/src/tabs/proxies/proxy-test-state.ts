import type { ProxyTestResult } from "../../api/proxies"

export interface ProxyTestState {
  revision: number
  pending: boolean
  result: ProxyTestResult | null
}
export type ProxyTestAction =
  | { type: "invalidate" | "start"; revision: number }
  | { type: "finish"; revision: number; result: ProxyTestResult }

export const initialProxyTestState: ProxyTestState = { revision: 0, pending: false, result: null }

export const reduceProxyTestState = (state: ProxyTestState, action: ProxyTestAction): ProxyTestState => {
  if (action.type === "finish" && action.revision !== state.revision) return state
  if (action.type === "finish") return { revision: action.revision, pending: false, result: action.result }
  return { revision: action.revision, pending: action.type === "start", result: null }
}
