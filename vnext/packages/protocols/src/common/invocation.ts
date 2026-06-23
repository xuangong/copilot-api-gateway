import type { EndpointKey } from './index'
import type { ExecuteResult } from './result'
import type { ProtocolFrame } from './sse'
import type { ChatCompletionsStreamEvent } from '../chat'
import type { MessagesStreamEvent } from '../messages'
import type { ResponsesStreamEvent } from '../responses'
import type { Interceptor } from '@vnext/service'

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
}

export type CopilotInterceptor = Interceptor<RequestContext, Invocation, Response>

export type ChatCompletionsStreamInterceptor = Interceptor<
  RequestContext,
  Invocation,
  ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>
>

export type MessagesStreamInterceptor = Interceptor<
  RequestContext,
  Invocation,
  ExecuteResult<ProtocolFrame<MessagesStreamEvent>>
>

export type ResponsesStreamInterceptor = Interceptor<
  RequestContext,
  Invocation,
  ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
>
