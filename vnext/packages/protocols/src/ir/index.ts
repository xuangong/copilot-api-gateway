/**
 * IR (Intermediate Representation) — single canonical shape every cross-protocol
 * operation works against. Modeled as OpenAI Responses superset + a meta field.
 *
 * Scope for Week 2: skeleton with minimal fields needed to round-trip the four
 * client protocols. Wire-level fidelity is added as adapters demand it.
 */
import type { ClientProtocol, EndpointKey, UpstreamKind } from '../common/index.ts'

/** A single content item inside an IR message. Mirrors Responses input items. */
export type IRContentItem =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string; annotations?: unknown[] }
  | { type: 'input_image'; image_url: string; detail?: 'auto' | 'low' | 'high' }
  | { type: 'tool_use'; id: string; name: string; arguments: unknown }
  | { type: 'tool_result'; tool_use_id: string; output: unknown; is_error?: boolean }
  | { type: 'reasoning'; summary?: string; encrypted_content?: string }
  // server-tool round-trip payload preserved opaquely between attempts
  | { type: 'opaque'; mime: string; data: unknown }

export interface IRMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: IRContentItem[] | string
  /** wire-id assigned by upstream if any — used by Responses item store */
  id?: string
}

export interface IRToolDef {
  type: 'function' | 'web_search' | 'image_generation' | 'code_interpreter'
  name: string
  description?: string
  parameters?: unknown
  strict?: boolean
}

export interface IRResolvedBinding {
  upstreamId: string
  upstreamKind: UpstreamKind
  upstreamModel: string
  targetApi: EndpointKey
}

export interface IRRequestMeta {
  /** flags resolved from upstream config + request headers */
  flags: Record<string, boolean>
  /** populated by binding resolver; null until then */
  binding: IRResolvedBinding | null
  /** orchestrator loop counter */
  iteration: number
  /** per-request scratchpad for server-tool plugins */
  privateState: Record<string, unknown>
  /** which client protocol the request entered as */
  clientProtocol: ClientProtocol
}

export interface IRRequest {
  model: string
  messages: IRMessage[]
  tools?: IRToolDef[]
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; name: string }
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  stream: boolean
  /** Responses-style continuation id; binding affinity uses this */
  previous_response_id?: string
  /** parallel_tool_calls and other generic knobs */
  parallel_tool_calls?: boolean
  /** raw client payload for adapters that need to inspect untranslated fields */
  rawClientPayload?: unknown
  meta: IRRequestMeta
}

/**
 * IR events follow a Responses-shaped superset. Adapters fan out to their own
 * protocol's SSE format. orchestrator.* events are internal and never reach the
 * wire.
 */
export type IREvent =
  | { type: 'response.created'; response: { id: string } }
  | { type: 'response.output_item.added'; item: IRContentItem & { id?: string } }
  | { type: 'response.output_text.delta'; itemId?: string; delta: string }
  | { type: 'response.tool_call.delta'; itemId: string; name?: string; argumentsDelta: string }
  | { type: 'response.tool_call.completed'; itemId: string; name: string; arguments: unknown }
  | { type: 'response.completed'; response: { id?: string; usage?: IRUsage; finish_reason?: string } }
  | { type: 'response.error'; error: { message: string; code?: string; status?: number } }
  | { type: 'orchestrator.iteration_start'; iteration: number }
  | { type: 'orchestrator.tool_dispatch'; toolName: string; itemId: string }

export interface IRUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  input_image_tokens?: number
  output_image_tokens?: number
}

/** ExecuteResult — interceptors return this; throw is forbidden for control flow. */
export type ExecuteResult<F> =
  | { kind: 'success'; frame: F }
  | { kind: 'retry-next-provider'; reason: string; lastError?: unknown }
  | { kind: 'client-error'; status: number; body: unknown }
  | { kind: 'upstream-error'; status: number; body: unknown; transient: boolean }

/** ProtocolFrame — SSE buffer + accumulator carried between interceptor layers. */
export interface ProtocolFrame<E = IREvent> {
  events: E[]
  /** terminal event already observed — interceptors must not append after this */
  terminated: boolean
}

export function freshFrame<E = IREvent>(): ProtocolFrame<E> {
  return { events: [], terminated: false }
}
