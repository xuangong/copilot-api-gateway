/**
 * ReAct multi-turn loop skeleton for the /v1/responses interceptor chain
 * (Spec 13 Phase 13-A-2).
 *
 * This is a *skeleton*: it establishes the loop scaffolding — iteration cap,
 * loop state, terminal-envelope synthesis hook — but does NOT dispatch any
 * hosted server tools. With no registrations, the loop is a pure pass-through:
 * one call to `run()` and its event stream flows to the client unchanged.
 *
 * The real ReAct dispatch (function_call interception + slot materialization
 * + follow-up turns) lands in Phase 13-B (shim core) + 13-C/D (plugins). This
 * file defines the interceptor's public shape so those phases can plug into
 * it without another attempt.ts refactor.
 *
 * Reference: copilot-gateway server-tool-shim.ts `runMultiTurnLoop` (line 852).
 */
import type { ResponsesInterceptor } from './types'
import type { ProtocolFrame } from '@vibe-core/result'
import type { ResponsesStreamEvent } from '@vibe-llm/protocols/responses'
import type { LlmExecuteResult } from '@vibe-llm/protocols/common'

/**
 * Default cap on ReAct loop iterations per request. Matches the reference
 * project's implicit expectation (server tools that runaway forever get shut
 * down before the client's timeout). The cap is a safety net — normal flows
 * exit at iteration 1 or 2 (initial turn + optional server-tool follow-up).
 */
export const DEFAULT_MAX_REACT_ITERATIONS = 8

/**
 * Feature flag guarding whether the shim runs at all. Off in Phase 13-A;
 * flipped to `true` in Phase 13-E cutover. While off, the interceptor is a
 * verbatim pass-through so the chain composition is exercised in tests
 * without any behavioral divergence from the pre-loop path.
 */
export const SERVER_TOOL_SHIM_ENABLED = false

export interface ReactLoopOptions {
  /** Overridable iteration cap; defaults to {@link DEFAULT_MAX_REACT_ITERATIONS}. */
  readonly maxIterations?: number
  /** Feature-flag override for tests. Production wiring uses {@link SERVER_TOOL_SHIM_ENABLED}. */
  readonly enabled?: boolean
}

interface LoopState {
  iterationCount: number
  readonly maxIterations: number
}

/**
 * Wrap the interceptor's `run()` in a ReAct loop.
 *
 * Skeleton semantics (Phase 13-A-2, no plugins registered):
 *   1. Call `run()` once — this drives the terminal (or the next interceptor
 *      inward).
 *   2. If the result is not an event stream (error / bridged), pass it
 *      through untouched.
 *   3. Otherwise, yield frames verbatim. Because there is no server-tool
 *      dispatch yet, the loop always exits after the first turn — there is
 *      nothing to trigger a follow-up.
 *
 * The `maxIterations` cap is enforced but unreachable in this phase (there
 * is no way to increment `iterationCount` past 1). Phase 13-B introduces the
 * dispatch that can drive additional turns and hit the cap.
 */
export const withResponsesReactLoop = (options: ReactLoopOptions = {}): ResponsesInterceptor => {
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_REACT_ITERATIONS
  const enabled = options.enabled ?? SERVER_TOOL_SHIM_ENABLED

  return async (_inv, _ctx, run) => {
    const result = await run()
    if (!enabled) return result
    if (result.type !== 'events') return result

    const loopState: LoopState = { iterationCount: 1, maxIterations }
    const upstream = result.events

    return {
      ...result,
      events: (async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
        for await (const frame of upstream) yield frame
        // Multi-turn dispatch hook lands in Phase 13-B. For now the loop always
        // exits after the initial turn — no server-tool result triggers a
        // follow-up call. `loopState.iterationCount` therefore never advances
        // past 1 in this phase; the cap check below is scaffolding for the
        // real dispatch to hook into.
        if (loopState.iterationCount > loopState.maxIterations) {
          // Unreachable in Phase 13-A-2. Kept as an assertion boundary so the
          // Phase 13-B dispatch code has a well-defined place to yield the
          // cap-exceeded terminal envelope from.
          throw new Error(
            `withResponsesReactLoop: iteration ${loopState.iterationCount} exceeded cap ${loopState.maxIterations}`,
          )
        }
      })(),
    } satisfies LlmExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
  }
}

/**
 * Terminal envelope synthesis hook.
 *
 * Phase 13-A-2 exposes this as a no-op placeholder so unit tests can pin the
 * public shape now. Phase 13-B replaces the body with the real
 * `synthesizeTerminalEnvelope` (ref shim line 786): merges accumulated
 * output, echoes tools + tool_choice, stamps `response.completed` /
 * `.failed` / `.incomplete`.
 */
export type SynthesizedTerminal =
  | { kind: 'completed' }
  | { kind: 'failed'; error: { code: string; message: string } }
  | { kind: 'incomplete'; incompleteDetails: unknown }

export const synthesizeTerminalEnvelope = (
  _kind: SynthesizedTerminal,
): ProtocolFrame<ResponsesStreamEvent> => {
  throw new Error(
    'synthesizeTerminalEnvelope: not implemented — Phase 13-B ports the shim core (ref: server-tool-shim.ts:786)',
  )
}
