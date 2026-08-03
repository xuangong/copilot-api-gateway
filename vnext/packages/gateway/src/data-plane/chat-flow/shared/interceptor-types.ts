// vnext/packages/gateway/src/data-plane/chat-flow/shared/interceptor-types.ts
/**
 * Shared interceptor alias for chat-flow attempts.
 *
 * All four source-protocol attempts (chat_completions, messages, responses,
 * gemini) build interceptor chains around `runInterceptors` from
 * `@vibe-core/service`. That helper is generic over `<Ctx, Req, R>`; every
 * chat-flow attempt binds `Ctx=RequestContext` and `Req=Invocation`, differing
 * only in the `R` (result) type. Prior to Circle D each attempt hand-rolled its
 * own local interceptor type or reached into `@vibe-llm/protocols/common` for
 * an endpoint-specific alias (`MessagesStreamInterceptor` etc.), and gemini
 * defined an ad-hoc shape whose `next` arity diverged from the service
 * contract — which is why the `runInterceptors` call sites required
 * `as never` casts.
 *
 * This alias is the single source of truth: declare interceptor arrays as
 * `ReadonlyArray<LlmInterceptor<X>>` and `runInterceptors` sees an aligned
 * signature with no casts. Kept in the gateway (not in `@vibe-core/service`)
 * so the service package doesn't need to reverse-depend on chat-flow types.
 */
import type { Interceptor } from '@vibe-core/service'
import type { Invocation, RequestContext } from '@vibe-llm/protocols/common'

export type LlmInterceptor<TResult> = Interceptor<RequestContext, Invocation, TResult>
