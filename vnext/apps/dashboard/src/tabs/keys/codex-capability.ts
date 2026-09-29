type CapabilityFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export function hasConfirmedCodexWebSocketCapability(
  state: { scope: string; available: boolean },
  currentScope: string,
): boolean {
  return state.scope === currentScope && state.available
}

export async function readCodexWebSocketCapability(
  origin: string,
  signal: AbortSignal,
  fetcher: CapabilityFetcher = fetch,
): Promise<boolean> {
  if (signal.aborted) return false
  try {
    const response = await fetcher(`${origin}/api/capabilities`, {
      credentials: "include",
      cache: "no-store",
      signal,
    })
    if (!response.ok || signal.aborted) return false
    const body: unknown = await response.json()
    if (signal.aborted || body === null || typeof body !== "object" || !("codex" in body)) return false
    const codex = body.codex
    if (codex === null || typeof codex !== "object" || !("responsesWebSocket" in codex)) return false
    const ingress = codex.responsesWebSocket
    if (ingress === null || typeof ingress !== "object") return false
    if (!("available" in ingress) || ingress.available !== true) return false
    if (!("mode" in ingress) || ingress.mode !== "single_turn") return false
    if (!("multiplex" in ingress) || ingress.multiplex !== false) return false
    if (!("fork" in ingress) || ingress.fork !== false) return false
    if (!("reconnectHistory" in ingress) || ingress.reconnectHistory !== false) return false
    if (!("maxConnectionOutboundBytes" in ingress)) return false
    return ingress.maxConnectionOutboundBytes === null || (
      typeof ingress.maxConnectionOutboundBytes === "number"
      && Number.isSafeInteger(ingress.maxConnectionOutboundBytes)
      && ingress.maxConnectionOutboundBytes > 0
    )
  } catch {
    return false
  }
}

export class CodexCapabilityRequestGate {
  private generation = 0
  private scope = ""
  private controller: AbortController | null = null

  begin(scope: string): { ticket: number; signal: AbortSignal } {
    this.controller?.abort()
    this.scope = scope
    this.controller = new AbortController()
    return { ticket: ++this.generation, signal: this.controller.signal }
  }

  accepts(ticket: number, scope: string): boolean {
    return ticket === this.generation && scope === this.scope && this.controller?.signal.aborted === false
  }

  invalidate(): void {
    this.controller?.abort()
    this.controller = null
    this.generation++
  }
}
