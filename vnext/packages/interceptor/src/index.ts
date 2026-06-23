/**
 * Compatibility shim. Real definitions live in:
 *   - @vnext/service             (Interceptor, Service, runInterceptors, Next)
 *   - @vnext/protocols/common    (Invocation, RequestContext, CopilotInterceptor, ...)
 * Slated for removal in Spec 7 Part 3 (T7). Do not add new code here —
 * new consumers should import directly from the source packages.
 */
export {
  runInterceptors,
  type Interceptor,
  type Service,
  type Next,
} from '@vnext/service'

export type { Next as InterceptorRun } from '@vnext/service'

export type {
  Invocation,
  RequestContext,
  CopilotInterceptor,
  ChatCompletionsStreamInterceptor,
  MessagesStreamInterceptor,
  ResponsesStreamInterceptor,
} from '@vnext/protocols/common'
