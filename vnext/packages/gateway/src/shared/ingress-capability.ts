import { AsyncLocalStorage } from "node:async_hooks"

export interface ResponsesWebSocketIngress {
  readonly maxConnectionOutboundBytes: number | null
}

const ingress = new AsyncLocalStorage<ResponsesWebSocketIngress>()

export function withResponsesWebSocketIngress<T>(
  capability: ResponsesWebSocketIngress,
  run: () => T,
): T {
  return ingress.run(capability, run)
}

export function currentResponsesWebSocketIngress(): ResponsesWebSocketIngress | null {
  return ingress.getStore() ?? null
}
