import type { EndpointKey } from './index'
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
