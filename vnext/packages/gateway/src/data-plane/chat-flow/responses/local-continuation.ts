import { responseContinuationItems } from "../../dispatch/responses-store-bridge.ts"
import { RESPONSES_WS_LOCAL_STATE_TTL_MS, RESPONSES_WS_MAX_LOCAL_STATE_BYTES, utf8Bytes } from "./session-limits.ts"

export interface LocalResponsesContinuation {
  readonly create: Record<string, unknown>
  readonly items: unknown[]
}
export interface ResponsesLocalContinuationResolver {
  resolve(id: string): LocalResponsesContinuation | undefined
}

/** Private latest-only state. TTL is logical: idle bytes are released on close,
 * replacement or the next read, not by an advertised idle reclamation timer. */
export class ResponsesLocalContinuation implements ResponsesLocalContinuationResolver {
  private slot?: { id: string; expiresAt: number; json: string }
  constructor(private readonly now = () => Date.now()) {}

  clear(): void { this.slot = undefined }

  candidate(id: string, create: Readonly<Record<string, unknown>>, output: readonly unknown[], compactTriggered = false): string | undefined {
    const { input, previous_response_id: _previous, stream: _stream, ...config } = create
    const items = responseContinuationItems(Array.isArray(input) ? input : [], output, compactTriggered)
    const json = JSON.stringify({ id, create: config, items })
    return utf8Bytes(json) <= RESPONSES_WS_MAX_LOCAL_STATE_BYTES ? json : undefined
  }

  publish(id: string, json: string | undefined): void {
    this.slot = json === undefined ? undefined : { id, json, expiresAt: this.now() + RESPONSES_WS_LOCAL_STATE_TTL_MS }
  }

  resolve(id: string): LocalResponsesContinuation | undefined {
    if (this.slot && this.now() >= this.slot.expiresAt) this.clear()
    if (!this.slot || this.slot.id !== id) return undefined
    return JSON.parse(this.slot.json) as LocalResponsesContinuation
  }
}
