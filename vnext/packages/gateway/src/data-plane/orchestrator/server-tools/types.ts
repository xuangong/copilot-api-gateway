/**
 * Server-tool plugin contract — Week 4b-1 scaffold.
 *
 * Ported from copilot-gateway server-tool-shim.ts. Plugin shape preserved
 * verbatim so the eventual web-search / image-generation port is a 1:1
 * mechanical move; full ReAct dispatch wiring lands in Week 4b-2 (loop)
 * and the plugin ports (Week 4b-3, 4b-4).
 *
 * Why open-shaped item/tool types here: packages/protocols/responses currently
 * exports only the payload schema, not narrowed item/tool unions. Mirroring the
 * old project's `{ type: string; [k]: unknown }` keeps the plugin contract
 * stable while protocol typing evolves.
 */

import type { ApiKeyId } from '../../../repo/branded-ids.ts'

export type ResponsesTool = { type: string; [key: string]: unknown }
export type ResponsesInputItem = { type: string; [key: string]: unknown }
export type ResponsesOutputItem = { type: string; id?: string; [key: string]: unknown }

export type ServerToolOutputItem = { type: string; id?: string; [key: string]: unknown }
export type ServerToolLifecycleEvent = { type: string; [key: string]: unknown }

export interface InterceptedFunctionCall {
  callId: string
  name: string
  /** jsonrepair-cleaned parsed arguments; null when not a JSON object. */
  arguments: Record<string, unknown> | null
}

export interface ServerToolTerminal {
  item: ServerToolOutputItem
  endEvents: ServerToolLifecycleEvent[]
  /** Server-only blob persisted via statefulResponsesContext.privatePayload. */
  privatePayload?: unknown
}

export interface ServerToolResultSlot {
  id: string
  startItem: ServerToolOutputItem
  startEvents: ServerToolLifecycleEvent[]
  /** Deferred lifecycle — yields intermediate events, returns terminal item. */
  run: () => AsyncGenerator<ServerToolLifecycleEvent, ServerToolTerminal>
}

export interface ServerToolLoopState {
  iterationCount: number
  remainingToolCalls: number | undefined
}

export interface DispatchedServerToolSlot {
  intercepted: InterceptedFunctionCall
  slot: ServerToolResultSlot
  outputIndex: number
}

export type ServerToolDispatcher = (args: {
  intercepted: InterceptedFunctionCall
  loopState: ServerToolLoopState
}) => ServerToolResultSlot[]

/**
 * 4-tuple — must move together. A partial declaration is a compile error
 * instead of a silently never-dispatching registration.
 *
 * `hostedTypes` powers `rewriteHostedToolChoice` (mapping a forced hosted
 * `tool_choice` back to the injected function tool). `canonicalize` both
 * matches an incoming raw tool AND returns the normalized hosted form the
 * shim later re-echoes downstream. Aligned with copilot-gateway
 * `server-tool-shim.ts` so the shim + plugin ports are 1:1.
 */
export interface ServerToolHostedDispatch {
  readonly hostedTypes: readonly string[]
  /**
   * `include` tokens that only exist to widen the hosted item this shim
   * replaces (e.g. `web_search_call.results`). The shim reads them for its own
   * state and then strips them from the outbound payload: the upstream never
   * emits the hosted item, and some upstreams — Copilot's grok-* / mai-code-*
   * Responses endpoint among them — reject the token outright rather than
   * ignoring it.
   */
  readonly includeTokens?: readonly string[]
  canonicalize: (raw: ResponsesTool) => ResponsesTool | undefined
  buildFunctionTool: (canonical: ResponsesTool, toolName: string) => ResponsesTool
  dispatcher: ServerToolDispatcher
}

export type ServerToolPrepareResult =
  | { type: 'inactive' }
  | { type: 'invalid-request'; message: string; param: string; code?: string }
  | {
      type: 'active'
      baseToolName: string
      /** History rewrite — applied even when the request no longer declares
       * the hosted tool, so prior-turn output items remain upstream-readable. */
      transformItems?: (items: ResponsesInputItem[], toolName: string) => ResponsesInputItem[]
      /** Present only when the request declares the hosted tool this turn. */
      hosted?: ServerToolHostedDispatch
    }

/** Per-request preparation hook. Receives invocation + request context;
 *  returns whether this plugin is inactive / active / rejected this turn. */
export type ServerToolRegistration<TInvocation, TRequest> = (
  ctx: TInvocation,
  request: TRequest,
) => ServerToolPrepareResult | Promise<ServerToolPrepareResult>

/**
 * What the shim hands to each registration alongside the invocation.
 *
 * Ported from copilot-gateway `ChatGatewayCtx`, trimmed to the fields the
 * plugins actually consume (`store` for private-payload round-tripping,
 * `apiKeyId` for usage attribution, `abortSignal` for provider cancellation).
 *
 * `upstreamIds` — image-generation plugin pins candidate enumeration to a
 * caller-supplied upstream set (matches reference `gatewayCtx.upstreamIds`).
 *
 * `backgroundScheduler` / `runtimeLocation` from reference are NOT threaded
 * through this ctx in vNext: `@vibe-core/platform` exposes both as
 * process-globals (`waitUntil()` / `getRuntimeLocation()`), so plugins
 * consume them directly instead of via ctx.
 */
export interface ServerToolRequestCtx {
  readonly store: import('./private-payload-store').PrivatePayloadStore
  readonly apiKeyId: ApiKeyId
  readonly abortSignal?: AbortSignal
  /** Caller-pinned upstream id set for candidate enumeration; null / omitted
   *  means "any upstream". Consumed by the image-generation plugin. */
  readonly upstreamIds?: readonly string[] | null
}

/** Plugin descriptor — what the registry stores. */
export interface ServerToolPlugin<TInvocation = unknown, TRequest = unknown> {
  name: string
  register: ServerToolRegistration<TInvocation, TRequest>
}
