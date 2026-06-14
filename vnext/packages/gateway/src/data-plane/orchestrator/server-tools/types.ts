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
 * 3-tuple — must move together. A partial declaration is a compile error
 * instead of a silently never-dispatching registration.
 */
export interface ServerToolHostedDispatch {
  isHostedTool: (tool: ResponsesTool) => boolean
  buildFunctionTool: (toolName: string) => ResponsesTool
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

/** Plugin descriptor — what the registry stores. */
export interface ServerToolPlugin<TInvocation = unknown, TRequest = unknown> {
  name: string
  register: ServerToolRegistration<TInvocation, TRequest>
}
