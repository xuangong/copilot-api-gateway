/**
 * Gemini interceptor type aliases.
 *
 * vNext specialisation: `Invocation.payload` is `Record<string, unknown>`
 * (see `@vibe-llm/protocols/common`) rather than a nominal `GeminiPayload`.
 * Each interceptor narrows the payload shape locally via cast at the seam
 * (see `strip-*.ts` and `suppress-thought-parts.ts`). Keeping the alias here
 * (rather than importing from `../attempt.ts`) mirrors the reference project
 * layout and avoids a cycle when the interceptor array is imported back into
 * the attempt module.
 */
import type { ProtocolFrame } from '@vibe-core/result'
import type { LlmExecuteResult } from '@vibe-llm/protocols/common'
import type { LlmInterceptor } from '../../shared/interceptor-types.ts'

export type GeminiInterceptor = LlmInterceptor<LlmExecuteResult<ProtocolFrame<unknown>>>
