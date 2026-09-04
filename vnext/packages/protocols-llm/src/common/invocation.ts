import type { EndpointKey } from './index'
import type { AccountType } from './index'
import type { LlmExecuteResult } from './result'
import type { ProtocolFrame } from '@vibe-core/result'
import type { ChatCompletionsStreamEvent } from '../chat'
import type { MessagesStreamEvent } from '../messages'
import type { ResponsesStreamEvent } from '../responses'
import type { Interceptor } from '@vibe-core/service'

export interface Invocation {
  readonly endpoint: EndpointKey
  readonly enabledFlags: ReadonlySet<string>
  readonly sourceApi?: 'messages' | 'chat_completions' | 'responses' | 'gemini'
  // Semantic verb the request performs against `endpoint`. `undefined`
  // ≡ `'generate'`. Set to `'compact'` by the `/v1/responses/compact`
  // route so the Responses compact-shim (see chat-flow/responses/
  // interceptors/with-responses-compact-shim.ts) can detect compact-shaped
  // requests without inspecting payload internals; interceptors may
  // mutate this field to pivot semantics (e.g. shim pivots to 'generate'
  // to route the summarization turn through the standard generate wire).
  action?: 'generate' | 'compact'
  payload: Record<string, unknown>
  headers: Record<string, string>
}

export interface RequestContext {
  readonly requestStartedAt: number
  readonly downstreamAbortSignal?: AbortSignal
  // Optional caller api key id. Threaded from `attempt.ts` where the
  // auth context is in scope so server-tool plugins (web-search,
  // image-generation) can attribute upstream usage back to the caller
  // without another lookup. Reference: copilot-gateway `ChatGatewayCtx.apiKeyId`.
  readonly apiKeyId?: string
  /** Canonical inbound model alias. It remains immutable for internal server-tool subcalls. */
  readonly incomingModel?: string
  // Selected target endpoint for this attempt. Injected by attempt.ts
  // just before `runInterceptors` so structurally-required interceptors
  // (e.g. Responses compact-shim on non-Responses upstreams) can detect
  // engagement without re-running binding selection. Optional to preserve
  // legacy test constructors that build a bare RequestContext.
  readonly targetEndpoint?: EndpointKey
  // Binding-visibility scope for this request, injected by attempt.ts from the
  // same auth context that selected the main binding.
  //
  // A server-tool plugin dispatches its own upstream call — the image shim
  // resolves the image model against `/images/generations`, which the
  // orchestrator's own binding cannot serve — so it has to re-enumerate. That
  // second enumeration must run under the *caller's* scope, or it sees only
  // globally-owned upstreams and reports a model the caller can plainly reach
  // as "no upstream provides model 'X'".
  //
  // Reference: copilot-gateway threads `GatewayCtx.upstreamIds` (an api-key
  // scoped upstream id set) into `ShimState` for exactly this. vNext scopes by
  // owner instead of by id set, so this carries the owner-shaped equivalent.
  readonly bindingScope?: BindingScope
}

/** Owner/pin/credential triple that decides which upstreams a request can see.
 *  Mirrors `ListUpstreamModelsOptions` in the gateway registry, declared here
 *  so `RequestContext` stays free of a gateway import. */
export interface BindingScope {
  readonly ownerId?: string
  readonly copilot?: { readonly copilotToken: string; readonly accountType: AccountType }
  /** Single-upstream pin from the model id (`model@upstream`) or the api key. */
  readonly pin?: string
}

export type CopilotInterceptor = Interceptor<RequestContext, Invocation, Response>

export type ChatCompletionsStreamInterceptor = Interceptor<
  RequestContext,
  Invocation,
  LlmExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>
>

export type MessagesStreamInterceptor = Interceptor<
  RequestContext,
  Invocation,
  LlmExecuteResult<ProtocolFrame<MessagesStreamEvent>>
>

export type ResponsesStreamInterceptor = Interceptor<
  RequestContext,
  Invocation,
  LlmExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
>
