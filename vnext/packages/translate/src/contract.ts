/** Adapter contract for client-protocol ↔ IR (frontend) and IR ↔ upstream (backend). */
import type { IRRequest, IREvent } from '@vnext/protocols/ir'

export interface FrontendAdapter<TPayload> {
  /** Parse + Zod-validate client payload; reject must mirror old worker's 4xx shape. */
  parse(raw: unknown): TPayload
  /** Pure translation from validated client payload into IR. */
  toIR(payload: TPayload): IRRequest
  /** Stream IR events back out as the client-expected SSE byte stream. */
  encodeSSE(events: AsyncIterable<IREvent>): ReadableStream<Uint8Array>
  /** Non-streaming: collapse IR events into the client's single-shot response body. */
  encodeBody(events: AsyncIterable<IREvent>): Promise<unknown>
}

export interface BackendAdapter {
  /** Build the upstream wire payload from IR. */
  toUpstream(req: IRRequest): unknown
  /** Translate upstream SSE bytes into IR events. */
  decodeSSE(stream: ReadableStream<Uint8Array>): AsyncIterable<IREvent>
  /** Non-streaming: translate upstream JSON body into IR events. */
  decodeBody(body: unknown): AsyncIterable<IREvent>
}

/** Helper: encode SSE event lines per the OpenAI/Anthropic convention. */
export function sseLine(event: string | null, data: unknown): string {
  const json = typeof data === 'string' ? data : JSON.stringify(data)
  return (event ? `event: ${event}\n` : '') + `data: ${json}\n\n`
}
