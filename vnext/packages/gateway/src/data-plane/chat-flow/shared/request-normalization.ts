import { beforeRequest, type RequestTransform } from "@vibe-core/service"
import type { Invocation, RequestContext } from "@vibe-llm/protocols/common"
import type { LlmInterceptor } from "./interceptor-types"

export type RequestNormalizationInput = Pick<Invocation, "payload" | "enabledFlags">

export type LlmRequestNormalizer = RequestTransform<RequestNormalizationInput>

export const withRequestNormalization = <TResult>(
  normalize: LlmRequestNormalizer,
): LlmInterceptor<TResult> => beforeRequest<RequestContext, Invocation, TResult>(normalize)
