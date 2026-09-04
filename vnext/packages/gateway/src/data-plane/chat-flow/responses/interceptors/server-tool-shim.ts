/**
 * Server-tool shim core (Spec 13 Phase 13-B).
 *
 * Ported 1:1 from copilot-gateway
 * `packages/gateway/src/data-plane/chat/responses/interceptors/server-tool-shim.ts`.
 *
 * The shim wraps `run()` from the interceptor chain and:
 *   - Rewrites hosted-tool declarations (e.g. web_search, image_generation) to
 *     function-tool equivalents so the upstream sees a function tool it will
 *     call by name.
 *   - Consumes the upstream stream turn-by-turn, intercepting matching
 *     function_call output items and dispatching them to server-tool plugins.
 *   - Materializes plugin output as ResponsesOutputItems downstream, with
 *     synthesized `response.output_item.added` / `.done` lifecycle events.
 *   - Runs a ReAct loop: after dispatch it re-invokes `run()` with the
 *     accumulated conversation, until upstream returns without another
 *     dispatched call or emits a client-visible tool_call.
 *   - Synthesizes the final `response.completed` / `.failed` / `.incomplete`
 *     envelope from accumulated shim state.
 *
 * Import adaptations from the reference:
 *   - `@floway-dev/protocols/responses` → `@vibe-llm/protocols/responses`; vNext
 *     lacks narrowed `ResponsesFunctionTool` / `ResponsesHostedTool` /
 *     `ResponsesToolChoice` / `CanonicalResponsesPayload` types. We use local
 *     aliases from `../../../orchestrator/server-tools/types` and treat
 *     tool_choice ad-hoc as `unknown | { type: string; name?: string; ... }`.
 *   - `@floway-dev/protocols/common` `eventFrame` / `ProtocolFrame` →
 *     `@vibe-core/result`.
 *   - `@floway-dev/provider` `ExecuteResult` / `EventResultMetadata` →
 *     `@vibe-llm/protocols/common` `LlmExecuteResult` / `EventResultMetadata`.
 *   - `InterceptorRun` → inferred from the third arg of `ResponsesInterceptor`.
 *   - `ResponsesInvocation` / `ChatGatewayCtx` → `Invocation` + `RequestContext`.
 *   - `StatefulResponsesStore.registerPrivatePayload` →
 *     `PrivatePayloadStore.registerPrivatePayload` (in-memory, per-request).
 *   - Reference `invalidRequestEnvelope` returns `type: 'api-error'`. vNext
 *     has no `api-error` variant; the closest match is `upstream-error` with
 *     status 400 and the same JSON body — the substitution is documented
 *     inline at the call site.
 */
import { parseServerToolArguments } from '../../shared/tool-arguments.ts'
import { serverToolTrace } from './server-tools/trace.ts'

import type { ResponsesInterceptor } from './types'
import { truncatePreservingCodePoints } from '../../shared/text'
import type { PrivatePayloadStore } from '../../../orchestrator/server-tools/private-payload-store'
import type { ApiKeyId } from '../../../../repo/branded-ids.ts'
import type {
  ResponsesTool,
  ResponsesInputItem,
  ResponsesOutputItem as ServerToolItemAlias,
  ServerToolDispatcher,
  ServerToolHostedDispatch,
  ServerToolLifecycleEvent,
  ServerToolLoopState,
  ServerToolOutputItem,
  ServerToolResultSlot,
  ServerToolTerminal,
  InterceptedFunctionCall,
  DispatchedServerToolSlot,
  ServerToolPrepareResult,
  ServerToolRegistration,
  ServerToolRequestCtx,
} from '../../../orchestrator/server-tools/types'
import { eventFrame, type ProtocolFrame } from '@vibe-core/result'
import {
  createRandomResponsesItemId,
  type ResponsesOutputItem,
  type ResponsesResult,
  type ResponsesStreamEvent,
} from '@vibe-llm/protocols/responses'
import type { EventResultMetadata, Invocation, LlmEventResult, LlmExecuteResult } from '@vibe-llm/protocols/common'
import { pickUsageModelId } from '../../../observability/usage-extractor.ts'

// InterceptorRun is the third arg of a ResponsesInterceptor.
type InterceptorRun<R> = () => Promise<R>

// vNext lacks narrowed tool/tool_choice types; use these loose aliases so we
// can port helpers verbatim while still having a name to reference.
type ResponsesHostedToolLoose = ResponsesTool
type ResponsesToolChoiceLoose = string | { type: string; name?: string; [k: string]: unknown } | null | undefined

export interface MergeUsage {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  input_tokens_details?: { cached_tokens: number; cache_write_tokens?: number }
  output_tokens_details?: { reasoning_tokens: number }
}

export interface MergeState {
  sequenceNumber: number
  outputIndex: number
  accumulatedOutput: Map<number, ResponsesOutputItem>
  accumulatedUsage: MergeUsage
  lastSeenModel: string | null
  synthesizedResponseId: string
  upstreamResponseSnapshot: ResponsesResult | undefined
}

export interface ActiveServerTool {
  type: 'active'
  baseToolName: string
  transformItems?: (items: ResponsesInputItem[], toolName: string) => ResponsesInputItem[]
  hosted?: ServerToolHostedDispatch
  toolName: string
  canonicalHostedTool: ResponsesHostedToolLoose | undefined
  originalToolChoice: Exclude<ResponsesToolChoiceLoose, string | null | undefined> | undefined
}

// How a single upstream turn ended, as observed while consuming its stream.
export type UpstreamTerminal =
  | { kind: 'completed' }
  | { kind: 'failed'; response: ResponsesResult }
  | { kind: 'incomplete'; response: ResponsesResult }
  | {
      kind: 'bare-error-pre-shell'
      error: { message: string; code: string }
      event: Extract<ResponsesStreamEvent, { type: 'error' }>
    }

export interface TurnSummary {
  dispatched: Array<{ intercepted: InterceptedFunctionCall; slots: DispatchedServerToolSlot[] }>
  sawClientToolCall: boolean
  turnUsage: MergeUsage
  terminalStatus: UpstreamTerminal
}

export type LatestUpstreamMetadata = {
  -readonly [K in 'modelIdentity' | 'performance']: EventResultMetadata[K]
} & {
  resolveModelIdentity?: LlmEventResult<unknown>['resolveModelIdentity']
}

const retainIncomingModel = (
  modelIdentity: EventResultMetadata['modelIdentity'],
  incomingModel: string,
): EventResultMetadata['modelIdentity'] =>
  modelIdentity.incomingModel === incomingModel
    ? modelIdentity
    : { ...modelIdentity, incomingModel }

// The terminal the shim emits downstream. Distinct from `UpstreamTerminal`
// (what we observed) — this carries only the already-extracted error /
// incompleteDetails the synthesized envelope needs.
export type SynthesizedTerminal =
  | { kind: 'completed' }
  | { kind: 'failed'; error: ResponsesResult['error'] }
  | { kind: 'incomplete'; incompleteDetails: ResponsesResult['incomplete_details'] }

export const createMergeState = (): MergeState => ({
  sequenceNumber: 0,
  outputIndex: 0,
  accumulatedOutput: new Map(),
  accumulatedUsage: {},
  lastSeenModel: null,
  synthesizedResponseId: `resp_shim_${crypto.randomUUID().replace(/-/g, '')}`,
  upstreamResponseSnapshot: undefined,
})

export const materializeAccumulatedOutput = (state: MergeState): ResponsesOutputItem[] => {
  const sorted = [...state.accumulatedOutput.keys()].sort((a, b) => a - b)
  return sorted.map((k) => state.accumulatedOutput.get(k)!)
}

export const sumUsage = (a: MergeUsage, b: MergeUsage): MergeUsage => {
  const out: MergeUsage = {}
  const sumScalar = (key: 'input_tokens' | 'output_tokens' | 'total_tokens'): void => {
    if (a[key] !== undefined || b[key] !== undefined) out[key] = (a[key] ?? 0) + (b[key] ?? 0)
  }
  sumScalar('input_tokens')
  sumScalar('output_tokens')
  sumScalar('total_tokens')
  if (a.input_tokens_details !== undefined || b.input_tokens_details !== undefined) {
    // cache_write_tokens stays optional: only one of the merged turns priming
    // the cache is normal, but neither having the field means the upstream
    // does not report it at all, and inventing a 0 would claim otherwise.
    const aWrite = a.input_tokens_details?.cache_write_tokens
    const bWrite = b.input_tokens_details?.cache_write_tokens
    out.input_tokens_details = {
      cached_tokens:
        (a.input_tokens_details?.cached_tokens ?? 0) + (b.input_tokens_details?.cached_tokens ?? 0),
      ...(aWrite !== undefined || bWrite !== undefined
        ? { cache_write_tokens: (aWrite ?? 0) + (bWrite ?? 0) }
        : {}),
    }
  }
  if (a.output_tokens_details !== undefined || b.output_tokens_details !== undefined) {
    out.output_tokens_details = {
      reasoning_tokens:
        (a.output_tokens_details?.reasoning_tokens ?? 0) +
        (b.output_tokens_details?.reasoning_tokens ?? 0),
    }
  }
  return out
}

const usageForWire = (state: MergeState): ResponsesResult['usage'] => {
  const u = state.accumulatedUsage
  if (
    u.input_tokens === undefined &&
    u.output_tokens === undefined &&
    u.total_tokens === undefined &&
    u.input_tokens_details === undefined &&
    u.output_tokens_details === undefined
  ) {
    return undefined
  }
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? 0,
    ...(u.input_tokens_details !== undefined ? { input_tokens_details: u.input_tokens_details } : {}),
    ...(u.output_tokens_details !== undefined ? { output_tokens_details: u.output_tokens_details } : {}),
  }
}

const usageOf = (usage: ResponsesResult['usage']): MergeUsage => {
  if (usage === undefined) return {}
  const out: MergeUsage = {}
  if (usage.input_tokens !== undefined) out.input_tokens = usage.input_tokens
  if (usage.output_tokens !== undefined) out.output_tokens = usage.output_tokens
  if (usage.total_tokens !== undefined) out.total_tokens = usage.total_tokens
  if (usage.input_tokens_details !== undefined) out.input_tokens_details = usage.input_tokens_details
  if (usage.output_tokens_details !== undefined) out.output_tokens_details = usage.output_tokens_details
  return out
}

export const rewriteHostedToolChoice = (
  toolChoice: ResponsesToolChoiceLoose,
  active: readonly ActiveServerTool[],
): ResponsesToolChoiceLoose => {
  if (toolChoice == null || typeof toolChoice === 'string') return toolChoice
  for (const entry of active) {
    if (entry.hosted === undefined) continue
    if (entry.hosted.hostedTypes.includes(toolChoice.type)) return { type: 'function', name: entry.toolName }
  }
  return toolChoice
}

// The shim demotes forced choice to `auto` after the first turn, so
// synthesized echoes restore the captured client shape rather than the
// final upstream echo.
export const restoreEchoedToolChoice = (
  toolChoice: ResponsesToolChoiceLoose,
  active: readonly ActiveServerTool[],
): ResponsesToolChoiceLoose => {
  for (const entry of active) {
    if (entry.originalToolChoice !== undefined) return entry.originalToolChoice
  }
  return toolChoice
}

// Inverse of the request-side hosted→function rewrite, applied to the
// upstream-echoed tools array. Non-injected entries pass through verbatim
// so upstream-side default enrichment on ordinary client function tools
// survives.
export const restoreEchoedTools = (
  tools: readonly ResponsesTool[] | undefined,
  active: readonly ActiveServerTool[],
): ResponsesTool[] | undefined => {
  if (tools === undefined) return undefined
  return tools.map((tool) => {
    if (tool.type !== 'function') return tool
    for (const entry of active) {
      if (
        entry.canonicalHostedTool !== undefined &&
        (tool as { name?: unknown }).name === entry.toolName
      ) {
        return entry.canonicalHostedTool
      }
    }
    return tool
  })
}

export const resolveServerToolName = (baseName: string, tools: readonly ResponsesTool[]): string => {
  const MAX_NAME_RESOLUTION_ATTEMPTS = 1000
  const taken = new Set(
    tools.flatMap((tool) =>
      tool.type === 'function' || tool.type === 'custom'
        ? [(tool as { name?: string }).name ?? '']
        : [],
    ),
  )
  if (!taken.has(baseName)) return baseName
  for (let i = 2; i <= MAX_NAME_RESOLUTION_ATTEMPTS; i++) {
    const candidate = `${baseName}_${i}`
    if (!taken.has(candidate)) return candidate
  }
  throw new Error(
    `Unable to resolve a free server tool function name for ${baseName} within ${MAX_NAME_RESOLUTION_ATTEMPTS} attempts`,
  )
}

// Azure and Copilot both deduplicate repeated hosted-tool declarations as one
// family and retain the last complete declaration, including aliases and
// configuration. The replacement occupies the first declaration's array slot
// so unrelated tools retain their relative order.
export const rewriteToolsForHostedShim = (
  tools: readonly ResponsesTool[],
  hosted: ServerToolHostedDispatch,
  toolName: string,
): { rewritten: ResponsesTool[]; canonicalHostedTool: ResponsesHostedToolLoose } => {
  const rewritten: ResponsesTool[] = []
  let canonicalHostedTool: ResponsesHostedToolLoose | undefined = undefined
  let replacementIndex = -1
  for (const raw of tools) {
    const canonical = hosted.canonicalize(raw)
    if (canonical === undefined) {
      rewritten.push(raw)
      continue
    }
    if (replacementIndex === -1) {
      replacementIndex = rewritten.length
      rewritten.push(raw)
    }
    canonicalHostedTool = canonical
  }
  if (canonicalHostedTool === undefined) {
    throw new Error('Hosted server-tool registration did not match any request tool')
  }
  rewritten[replacementIndex] = hosted.buildFunctionTool(canonicalHostedTool, toolName)
  return { rewritten, canonicalHostedTool }
}

// Re-exported from its shared home so the Chat Completions web-search shim
// can parse tool arguments the same way without importing this module.
export { parseServerToolArguments }

const syntheticPrologueResponse = (
  state: MergeState,
  id: string,
  model: string,
  active: readonly ActiveServerTool[],
  status: 'queued' | 'in_progress',
): ResponsesResult => {
  if (state.upstreamResponseSnapshot === undefined) {
    throw new Error(
      'Server-tool shim cannot synthesize a Responses prologue envelope before an upstream response snapshot is captured.',
    )
  }
  const snapshot = state.upstreamResponseSnapshot
  const snap = snapshot as ResponsesResult & { tools?: ResponsesTool[]; tool_choice?: ResponsesToolChoiceLoose }
  const restoredTools = restoreEchoedTools(snap.tools, active)
  const restoredToolChoice = restoreEchoedToolChoice(snap.tool_choice, active)
  return {
    ...snapshot,
    id,
    object: 'response',
    model,
    output: [],
    status,
    error: null,
    incomplete_details: null,
    ...(restoredTools !== undefined ? { tools: restoredTools } : {}),
    ...(restoredToolChoice !== undefined ? { tool_choice: restoredToolChoice } : {}),
  } as ResponsesResult
}

const rewriteOutputIndex = (
  event: ResponsesStreamEvent,
  openItems: Map<number, number>,
  openItemIds: Map<number, string>,
  merge: MergeState,
): ResponsesStreamEvent | null => {
  const indexed = event as ResponsesStreamEvent & { output_index?: unknown; item_id?: unknown }
  if (typeof indexed.output_index !== 'number') return null
  let downstreamIndex = openItems.get(indexed.output_index)
  if (downstreamIndex === undefined) {
    downstreamIndex = merge.outputIndex++
    openItems.set(indexed.output_index, downstreamIndex)
  }
  const downstreamItemId = openItemIds.get(indexed.output_index)
  return {
    ...event,
    output_index: downstreamIndex,
    ...(typeof indexed.item_id === 'string' && downstreamItemId !== undefined ? { item_id: downstreamItemId } : {}),
  } as ResponsesStreamEvent
}

const captureReportedResponse = (merge: MergeState, response: ResponsesResult): void => {
  if (typeof response.model === 'string' && response.model.length > 0) {
    merge.lastSeenModel = merge.lastSeenModel === null
      ? response.model
      : pickUsageModelId(response.model, merge.lastSeenModel)
  }
  merge.upstreamResponseSnapshot = response
}

const captureTerminalEvent = (
  event: ResponsesStreamEvent,
  merge: MergeState,
): { status: UpstreamTerminal; usage: MergeUsage } | null => {
  if (event.type === 'response.completed') {
    captureReportedResponse(merge, event.response)
    return { status: { kind: 'completed' }, usage: usageOf(event.response.usage) }
  }
  if (event.type === 'response.failed') {
    captureReportedResponse(merge, event.response)
    return { status: { kind: 'failed', response: event.response }, usage: usageOf(event.response.usage) }
  }
  if (event.type === 'response.incomplete') {
    captureReportedResponse(merge, event.response)
    return { status: { kind: 'incomplete', response: event.response }, usage: usageOf(event.response.usage) }
  }
  return null
}

const stampServerToolEvent = (
  merge: MergeState,
  outputIndex: number,
  itemId: string,
  event: ServerToolLifecycleEvent,
): ProtocolFrame<ResponsesStreamEvent> =>
  eventFrame({
    ...event,
    output_index: outputIndex,
    item_id: itemId,
    sequence_number: merge.sequenceNumber++,
  } as ResponsesStreamEvent)

const attachServerToolItemId = (item: ServerToolOutputItem, id: string): ResponsesOutputItem =>
  ({ ...item, id }) as ResponsesOutputItem

const serverToolStartFrames = (
  merge: MergeState,
  outputIndex: number,
  slot: ServerToolResultSlot,
): ProtocolFrame<ResponsesStreamEvent>[] => [
  eventFrame({
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: attachServerToolItemId(slot.startItem, slot.id),
    sequence_number: merge.sequenceNumber++,
  } as ResponsesStreamEvent),
  ...slot.startEvents.map((event) => stampServerToolEvent(merge, outputIndex, slot.id, event)),
]

const serverToolEndFrames = (
  merge: MergeState,
  outputIndex: number,
  slot: ServerToolResultSlot,
  result: ServerToolTerminal,
): ProtocolFrame<ResponsesStreamEvent>[] => {
  const frames = [
    ...result.endEvents.map((event) => stampServerToolEvent(merge, outputIndex, slot.id, event)),
    eventFrame({
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: attachServerToolItemId(result.item, slot.id),
      sequence_number: merge.sequenceNumber++,
    } as ResponsesStreamEvent),
  ]
  merge.accumulatedOutput.set(outputIndex, attachServerToolItemId(result.item, slot.id))
  return frames
}

const transformServerToolItems = (
  items: ResponsesInputItem[],
  active: readonly ActiveServerTool[],
): ResponsesInputItem[] => {
  let next = items
  for (const entry of active) {
    if (entry.transformItems !== undefined) next = entry.transformItems(next, entry.toolName)
  }
  return next
}

export const consumeTurnStreaming = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  merge: MergeState,
  isFirstTurn: boolean,
  dispatchers: ReadonlyMap<string, ServerToolDispatcher>,
  loopState: ServerToolLoopState,
  active: readonly ActiveServerTool[],
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>, TurnSummary> {
  const dispatched: Array<{ intercepted: InterceptedFunctionCall; slots: DispatchedServerToolSlot[] }> = []
  let sawClientToolCall = false
  let turnUsage: MergeUsage = {}
  let terminalStatus: UpstreamTerminal | undefined = undefined

  const openItems = new Map<number, number>()
  const openItemIds = new Map<number, string>()
  const interceptedByUpstreamIndex = new Map<
    number,
    {
      intercepted: InterceptedFunctionCall
      dispatcher: ServerToolDispatcher
      reservedOutputIndex: number
      argumentsJson: string
    }
  >()

  const ensureModel = (): string => {
    if (merge.lastSeenModel === null) {
      throw new Error(
        'Server-tool shim cannot synthesize a Responses envelope because upstream `response.created` did not report a `model` field.',
      )
    }
    return merge.lastSeenModel
  }

  const stamp = (event: ResponsesStreamEvent): ProtocolFrame<ResponsesStreamEvent> =>
    eventFrame({
      ...event,
      sequence_number: merge.sequenceNumber++,
    } as ResponsesStreamEvent)

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame
      continue
    }
    const event = frame.event

    const eventType = (event as { type: string }).type
    if (eventType === 'response.queued' || eventType === 'response.created') {
      captureReportedResponse(merge, (event as { response: ResponsesResult }).response)
      ensureModel()
      if (isFirstTurn) {
        const status = eventType === 'response.queued' ? 'queued' : 'in_progress'
        yield stamp({
          type: eventType,
          response: syntheticPrologueResponse(merge, merge.synthesizedResponseId, ensureModel(), active, status),
        } as ResponsesStreamEvent)
      }
      continue
    }

    if (event.type === 'response.in_progress') {
      captureReportedResponse(merge, event.response)
      if (isFirstTurn) {
        yield stamp({
          type: 'response.in_progress',
          response: syntheticPrologueResponse(
            merge,
            merge.synthesizedResponseId,
            ensureModel(),
            active,
            'in_progress',
          ),
        })
      }
      continue
    }

    if (event.type === 'error') {
      const e = event as Extract<ResponsesStreamEvent, { type: 'error' }>
      const code = typeof e.code === 'string' && e.code.length > 0 ? e.code : 'server_error'
      if (merge.upstreamResponseSnapshot === undefined) {
        terminalStatus = {
          kind: 'bare-error-pre-shell',
          error: { message: e.message, code },
          event: e,
        }
      } else {
        terminalStatus = {
          kind: 'failed',
          response: {
            id: merge.synthesizedResponseId,
            object: 'response',
            model: ensureModel(),
            output: [],
            status: 'failed',
            error: { message: e.message, code },
            incomplete_details: null,
          },
        }
      }
      turnUsage = {}
      continue
    }

    const terminal = captureTerminalEvent(event, merge)
    if (terminal !== null) {
      terminalStatus = terminal.status
      turnUsage = terminal.usage
      continue
    }

    if (event.type === 'response.output_item.added') {
      const upstreamIndex = event.output_index
      const item = event.item
      if (item.type === 'function_call') {
        const dispatcher = dispatchers.get(item.name)
        if (dispatcher !== undefined) {
          interceptedByUpstreamIndex.set(upstreamIndex, {
            dispatcher,
            reservedOutputIndex: merge.outputIndex++,
            argumentsJson: '',
            intercepted: {
              callId: item.call_id,
              name: item.name,
              arguments: {},
            },
          })
          continue
        }
      }

      if (item.type === 'function_call' || item.type === 'custom_tool_call') sawClientToolCall = true

      const downstreamIndex = merge.outputIndex++
      openItems.set(upstreamIndex, downstreamIndex)
      const wireItemId = (item as { id?: unknown }).id
      const itemId =
        typeof wireItemId === 'string' && wireItemId.length > 0
          ? wireItemId
          : item.type === 'message'
          ? createRandomResponsesItemId('message')
          : undefined
      if (itemId !== undefined) openItemIds.set(upstreamIndex, itemId)
      yield stamp({
        type: 'response.output_item.added',
        output_index: downstreamIndex,
        item:
          itemId !== undefined && wireItemId !== itemId
            ? ({ ...item, id: itemId } as ResponsesOutputItem)
            : item,
      })
      continue
    }

    if (event.type === 'response.output_item.done') {
      const upstreamIndex = event.output_index
      const intercepted = interceptedByUpstreamIndex.get(upstreamIndex)
      if (intercepted !== undefined) {
        if (event.item.type === 'function_call') intercepted.argumentsJson = event.item.arguments
        intercepted.intercepted.arguments = parseServerToolArguments(intercepted.argumentsJson)
        serverToolTrace('dispatch', {
          tool: intercepted.intercepted.name,
          iteration: loopState.iterationCount,
          remainingToolCalls: loopState.remainingToolCalls ?? null,
        })
        const slots = intercepted.dispatcher({ intercepted: intercepted.intercepted, loopState })
        if (loopState.remainingToolCalls !== undefined) loopState.remainingToolCalls -= 1
        const dispatchedSlots: DispatchedServerToolSlot[] = []
        for (const [slotIndex, slot] of slots.entries()) {
          const outputIndex = slotIndex === 0 ? intercepted.reservedOutputIndex : merge.outputIndex++
          dispatchedSlots.push({ intercepted: intercepted.intercepted, slot, outputIndex })
          yield* serverToolStartFrames(merge, outputIndex, slot)
        }
        dispatched.push({ intercepted: intercepted.intercepted, slots: dispatchedSlots })
        continue
      }

      const downstreamIndex = openItems.get(upstreamIndex)
      if (downstreamIndex === undefined) continue
      const itemId = openItemIds.get(upstreamIndex)
      const upstreamDoneItemId = (event.item as { id?: unknown }).id
      const doneItem: ResponsesOutputItem =
        itemId !== undefined && upstreamDoneItemId !== itemId
          ? ({ ...event.item, id: itemId } as ResponsesOutputItem)
          : event.item
      yield stamp({ type: 'response.output_item.done', output_index: downstreamIndex, item: doneItem })
      merge.accumulatedOutput.set(downstreamIndex, doneItem)
      continue
    }

    if (event.type === 'response.function_call_arguments.delta') {
      const intercepted = interceptedByUpstreamIndex.get(event.output_index)
      if (intercepted !== undefined) {
        intercepted.argumentsJson += event.delta
        continue
      }
      const rewritten = rewriteOutputIndex(event, openItems, openItemIds, merge)
      if (rewritten !== null) yield stamp(rewritten)
      continue
    }

    if (event.type === 'response.function_call_arguments.done') {
      const intercepted = interceptedByUpstreamIndex.get(event.output_index)
      if (intercepted !== undefined) {
        intercepted.argumentsJson = event.arguments
        continue
      }
      const rewritten = rewriteOutputIndex(event, openItems, openItemIds, merge)
      if (rewritten !== null) yield stamp(rewritten)
      continue
    }

    const maybeIndexedForIntercepted = event as ResponsesStreamEvent & { output_index?: unknown }
    if (
      typeof maybeIndexedForIntercepted.output_index === 'number' &&
      interceptedByUpstreamIndex.has(maybeIndexedForIntercepted.output_index)
    ) {
      continue
    }

    const rewriteResult = rewriteOutputIndex(event, openItems, openItemIds, merge)
    if (rewriteResult !== null) {
      const maybeItemEvent = rewriteResult as ResponsesStreamEvent & {
        output_index?: number
        item?: unknown
      }
      if (
        maybeItemEvent.item !== undefined &&
        typeof maybeItemEvent.output_index === 'number' &&
        (rewriteResult.type.endsWith('.added') || rewriteResult.type.endsWith('.done'))
      ) {
        merge.accumulatedOutput.set(
          maybeItemEvent.output_index,
          maybeItemEvent.item as ResponsesOutputItem,
        )
      }
      yield stamp(rewriteResult)
      continue
    }
  }

  if (terminalStatus === undefined) {
    if (merge.upstreamResponseSnapshot === undefined) {
      terminalStatus = {
        kind: 'bare-error-pre-shell',
        error: {
          message: 'Upstream stream ended without a terminal event (no response.created observed)',
          code: 'server_error',
        },
        event: {
          type: 'error',
          message: 'Upstream stream ended without a terminal event (no response.created observed)',
          code: 'server_error',
        } as Extract<ResponsesStreamEvent, { type: 'error' }>,
      }
    } else {
      terminalStatus = {
        kind: 'failed',
        response: {
          id: merge.synthesizedResponseId,
          object: 'response',
          model: ensureModel(),
          output: [],
          status: 'failed',
          error: { message: 'Upstream stream ended without a terminal event.', code: 'server_error' },
          incomplete_details: null,
        },
      }
    }
  }

  if (interceptedByUpstreamIndex.size > dispatched.length) {
    const dispatchedSet = new Set(dispatched.map((d) => d.intercepted))
    const unmatched = [...interceptedByUpstreamIndex.entries()]
      .filter(([, intercepted]) => !dispatchedSet.has(intercepted.intercepted))
      .map(([idx]) => idx)
    const priorKind = terminalStatus.kind
    const priorLabel = priorKind === 'bare-error-pre-shell' ? 'a pre-shell bare error' : `response.${priorKind}`
    terminalStatus = {
      kind: 'failed',
      response: {
        id: merge.synthesizedResponseId,
        object: 'response',
        model: ensureModel(),
        output: [],
        status: 'failed',
        error: {
          message: `Upstream emitted ${priorLabel} without closing shim call items at upstream output_index ${unmatched.join(', ')}.`,
          code: 'server_error',
        },
        incomplete_details: null,
      },
    }
  }

  return { dispatched, sawClientToolCall, turnUsage, terminalStatus }
}

const MAX_BODY_EXCERPT_CHARS = 512

const buildErrorFromResult = (
  result: Exclude<LlmExecuteResult<unknown>, { type: 'events' }>,
): NonNullable<ResponsesResult['error']> => {
  if (result.type === 'internal-error') return { message: result.error.message, code: 'server_error' }
  const decoded = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(result.body)
  let parsed: unknown = undefined
  try {
    parsed = JSON.parse(decoded)
  } catch {
    parsed = undefined
  }
  const err = typeof parsed === 'object' && parsed !== null ? (parsed as { error?: unknown }).error : undefined
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>
    const out: NonNullable<ResponsesResult['error']> = {
      message: typeof e.message === 'string' ? e.message : `Upstream returned HTTP ${result.status}`,
      code: typeof e.code === 'string' ? e.code : `upstream_${result.status}`,
    }
    if (typeof e.type === 'string') (out as Record<string, unknown>).type = e.type
    return out
  }
  const truncated = truncatePreservingCodePoints(decoded, MAX_BODY_EXCERPT_CHARS)
  const excerpt = truncated.length === decoded.length ? decoded : `${truncated}...`
  return {
    message:
      excerpt.length > 0 ? `Upstream returned HTTP ${result.status}: ${excerpt}` : `Upstream returned HTTP ${result.status}`,
    code: `upstream_${result.status}`,
  }
}

// Reference used `type: 'api-error'`; vNext lacks that variant. We emit an
// `upstream-error` with status 400 and the same JSON body — semantically the
// closest fit for a synthesized 400 from the shim's own invalid-request path.
const invalidRequestEnvelope = (
  message: string,
  param: string | null,
  code: string | null | undefined,
  errorType = 'invalid_request_error',
): LlmExecuteResult<ProtocolFrame<ResponsesStreamEvent>> => {
  const body = JSON.stringify({
    error: {
      message,
      type: errorType,
      param,
      code: code === undefined ? 'invalid_request_error' : code,
    },
  })
  return {
    type: 'upstream-error',
    status: 400,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: new TextEncoder().encode(body),
  }
}

const SYNTHESIZED_TERMINAL_FRAME: Record<
  SynthesizedTerminal['kind'],
  { type: 'response.completed' | 'response.failed' | 'response.incomplete'; status: ResponsesResult['status'] }
> = {
  completed: { type: 'response.completed', status: 'completed' },
  failed: { type: 'response.failed', status: 'failed' },
  incomplete: { type: 'response.incomplete', status: 'incomplete' },
}

export const synthesizeTerminalEnvelope = (
  state: MergeState,
  kind: SynthesizedTerminal,
  active: readonly ActiveServerTool[],
): ProtocolFrame<ResponsesStreamEvent> => {
  if (state.lastSeenModel === null) {
    throw new Error(
      'Server-tool shim cannot synthesize a Responses terminal envelope before upstream `response.created` reports a model.',
    )
  }
  if (state.upstreamResponseSnapshot === undefined) {
    throw new Error(
      'Server-tool shim cannot synthesize a Responses terminal envelope before upstream `response.created` is captured.',
    )
  }
  const output = materializeAccumulatedOutput(state)
  const usage = usageForWire(state)
  const frame = SYNTHESIZED_TERMINAL_FRAME[kind.kind]
  let outputText = ''
  for (const item of output) {
    if (item.type !== 'message') continue
    for (const block of item.content) {
      if (block.type === 'output_text') outputText += block.text
    }
  }
  const snapshot = state.upstreamResponseSnapshot
  const snap = snapshot as ResponsesResult & { tools?: ResponsesTool[]; tool_choice?: ResponsesToolChoiceLoose }
  const restoredTools = restoreEchoedTools(snap.tools, active)
  const restoredToolChoice = restoreEchoedToolChoice(snap.tool_choice, active)
  return eventFrame({
    type: frame.type,
    sequence_number: state.sequenceNumber++,
    response: {
      ...snapshot,
      id: state.synthesizedResponseId,
      object: 'response',
      model: state.lastSeenModel,
      status: frame.status,
      output,
      output_text: outputText,
      ...(restoredTools !== undefined ? { tools: restoredTools } : {}),
      ...(restoredToolChoice !== undefined ? { tool_choice: restoredToolChoice } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(kind.kind === 'failed' ? { error: kind.error } : {}),
      ...(kind.kind === 'incomplete' ? { incomplete_details: kind.incompleteDetails } : {}),
    },
  } as ResponsesStreamEvent)
}

export async function* materializeServerToolItems(
  dispatched: ReadonlyArray<{ slots: DispatchedServerToolSlot[] }>,
  merge: MergeState,
  store: PrivatePayloadStore,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>, void> {
  for (const d of dispatched) {
    for (const { slot, outputIndex } of d.slots) {
      const lifecycle = slot.run()
      let step = await lifecycle.next()
      while (!step.done) {
        yield stampServerToolEvent(merge, outputIndex, slot.id, step.value)
        step = await lifecycle.next()
      }
      // Register private dispatcher state under the emitted item id so
      // output persistence captures it and replay-side `transformItems` can
      // restore it on the next loop turn.
      store.registerPrivatePayload(slot.id, step.value.privatePayload)
      yield* serverToolEndFrames(merge, outputIndex, slot, step.value)
    }
  }
}

// Explicit any suppression: the reference uses CanonicalResponsesPayload for
// ctx.payload; vNext ctx.payload is Record<string, unknown>. We access
// fields ad-hoc and cast when writing.
async function* runMultiTurnLoop(args: {
  ctx: Invocation
  run: InterceptorRun<LlmExecuteResult<ProtocolFrame<ResponsesStreamEvent>>>
  merge: MergeState
  loopState: ServerToolLoopState
  demoteForcedServerToolChoiceAfterFirstTurn: boolean
  turn1Iter: AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>, TurnSummary>
  dispatchers: ReadonlyMap<string, ServerToolDispatcher>
  store: PrivatePayloadStore
  canonicalInput: ResponsesInputItem[]
  active: readonly ActiveServerTool[]
  metadata: LatestUpstreamMetadata
  incomingModel: string
  resolveFinalMetadata: (m: EventResultMetadata) => void
}): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const {
    ctx,
    run,
    merge,
    loopState,
    demoteForcedServerToolChoiceAfterFirstTurn,
    turn1Iter,
    dispatchers,
    store,
    active,
    metadata,
    incomingModel,
    resolveFinalMetadata,
  } = args
  const baseInput = args.canonicalInput
  try {
    let currentTurn: TurnSummary = yield* turn1Iter
    merge.accumulatedUsage = sumUsage(merge.accumulatedUsage, currentTurn.turnUsage)
    while (true) {
      const turn = currentTurn
      const executedShim = turn.dispatched.length > 0

      if (turn.terminalStatus.kind === 'failed') {
        if (executedShim) yield* materializeServerToolItems(turn.dispatched, merge, store)
        yield synthesizeTerminalEnvelope(merge, { kind: 'failed', error: turn.terminalStatus.response.error }, active)
        return
      }
      if (turn.terminalStatus.kind === 'incomplete') {
        if (executedShim) yield* materializeServerToolItems(turn.dispatched, merge, store)
        yield synthesizeTerminalEnvelope(
          merge,
          { kind: 'incomplete', incompleteDetails: turn.terminalStatus.response.incomplete_details },
          active,
        )
        return
      }
      if (turn.terminalStatus.kind === 'bare-error-pre-shell') {
        // No upstream response lifecycle was captured, so there is no shell
        // from which a valid terminal envelope can be synthesized. Preserve
        // the upstream error rather than replacing it with a shim prerequisite
        // failure. The binding-time identity remains authoritative metadata.
        yield eventFrame(turn.terminalStatus.event)
        return
      }
      if (!executedShim && !turn.sawClientToolCall) {
        yield synthesizeTerminalEnvelope(merge, { kind: 'completed' }, active)
        return
      }

      yield* materializeServerToolItems(turn.dispatched, merge, store)
      if (turn.sawClientToolCall) {
        yield synthesizeTerminalEnvelope(merge, { kind: 'completed' }, active)
        return
      }

      // Accumulated output items are fed back as the next turn's input.
      // A Responses output item is a structural superset of the matching
      // input item for every shape we emit here.
      const nextCanonicalInput: ResponsesInputItem[] = [
        ...baseInput,
        ...materializeAccumulatedOutput(merge).map((item) => item as unknown as ResponsesInputItem),
      ]
      const nextPayload: Record<string, unknown> = {
        ...ctx.payload,
        input: transformServerToolItems(nextCanonicalInput, active),
      }
      if (loopState.remainingToolCalls !== undefined) {
        nextPayload.max_tool_calls = Math.max(0, loopState.remainingToolCalls)
      } else {
        delete nextPayload.max_tool_calls
      }
      ctx.payload = nextPayload

      if (demoteForcedServerToolChoiceAfterFirstTurn) ctx.payload = { ...ctx.payload, tool_choice: 'auto' }
      loopState.iterationCount += 1

      const nextResult = await run()
      if (nextResult.type !== 'events') {
        yield synthesizeTerminalEnvelope(merge, { kind: 'failed', error: buildErrorFromResult(nextResult) }, active)
        return
      }
      metadata.modelIdentity = retainIncomingModel(nextResult.modelIdentity, incomingModel)
      metadata.performance = nextResult.performance
      metadata.resolveModelIdentity = (modelKey) => {
        const resolved = nextResult.resolveModelIdentity?.(modelKey) ?? nextResult.modelIdentity
        return retainIncomingModel(resolved, incomingModel)
      }
      currentTurn = yield* consumeTurnStreaming(nextResult.events, merge, false, dispatchers, loopState, active)
      merge.accumulatedUsage = sumUsage(merge.accumulatedUsage, currentTurn.turnUsage)
    }
  } catch (error) {
    if (merge.upstreamResponseSnapshot === undefined) {
      yield eventFrame({
        type: 'error',
        message: `Upstream stream failed before response lifecycle: ${error instanceof Error ? error.message : String(error)}`,
        code: 'server_error',
      } as Extract<ResponsesStreamEvent, { type: 'error' }>)
      return
    }
    yield synthesizeTerminalEnvelope(
      merge,
      {
        kind: 'failed',
        error: {
          code: 'server_error',
          message: `Upstream stream failed mid-response: ${error instanceof Error ? error.message : String(error)}`,
        },
      },
      active,
    )
  } finally {
    const observed = merge.lastSeenModel
    const modelKey = observed === null
      ? metadata.modelIdentity.modelKey
      : pickUsageModelId(observed, metadata.modelIdentity.modelKey)
    const modelIdentity = modelKey === metadata.modelIdentity.modelKey
      ? metadata.modelIdentity
      : metadata.resolveModelIdentity?.(modelKey) ?? metadata.modelIdentity
    resolveFinalMetadata({
      modelIdentity: retainIncomingModel(modelIdentity, incomingModel),
      performance: metadata.performance,
    })
  }
}

export const withResponsesServerToolShim = (
  registrations: readonly ServerToolRegistration<Invocation, ServerToolRequestCtx>[],
  store: PrivatePayloadStore,
): ResponsesInterceptor => async (ctx, gatewayCtx, run) => {
  const requestCtx: ServerToolRequestCtx = {
    store,
    apiKeyId: (gatewayCtx.apiKeyId ?? '') as ApiKeyId,
    ...(gatewayCtx.incomingModel !== undefined ? { incomingModel: gatewayCtx.incomingModel } : {}),
    ...(gatewayCtx.bindingScope !== undefined ? { bindingScope: gatewayCtx.bindingScope } : {}),
    ...(gatewayCtx.downstreamAbortSignal !== undefined ? { abortSignal: gatewayCtx.downstreamAbortSignal } : {}),
  }
  const active: ActiveServerTool[] = []

  for (const prepareServerTool of registrations) {
    const prepared: ServerToolPrepareResult = await prepareServerTool(ctx, requestCtx)
    if (prepared.type === 'inactive') continue
    if (prepared.type === 'invalid-request') {
      return invalidRequestEnvelope(prepared.message, prepared.param, prepared.code)
    }
    const currentTools = Array.isArray(ctx.payload.tools) ? (ctx.payload.tools as ResponsesTool[]) : []
    const toolName = resolveServerToolName(prepared.baseToolName, currentTools)
    const { hosted } = prepared
    let canonicalHostedTool: ResponsesHostedToolLoose | undefined = undefined
    if (hosted !== undefined) {
      const rewrite = rewriteToolsForHostedShim(currentTools, hosted, toolName)
      canonicalHostedTool = rewrite.canonicalHostedTool
      ctx.payload = { ...ctx.payload, tools: rewrite.rewritten }
      // The hosted item is synthesized here, never upstream, so its `include`
      // opt-ins are dead weight on the wire — and grok-* / mai-code-* reject
      // rather than ignore them. Registrations have already read whatever they
      // need out of `include` during prepare.
      const owned = hosted.includeTokens
      if (owned?.length && Array.isArray(ctx.payload.include)) {
        const kept = (ctx.payload.include as unknown[]).filter(
          (token) => typeof token !== 'string' || !owned.includes(token),
        )
        const { include: _dropped, ...rest } = ctx.payload as Record<string, unknown>
        ctx.payload = (kept.length ? { ...rest, include: kept } : rest) as typeof ctx.payload
      }
    }
    const rawToolChoice = ctx.payload.tool_choice as ResponsesToolChoiceLoose
    const originalToolChoice =
      hosted !== undefined &&
      typeof rawToolChoice === 'object' &&
      rawToolChoice !== null &&
      hosted.hostedTypes.includes(rawToolChoice.type)
        ? rawToolChoice
        : undefined
    active.push({ ...prepared, toolName, canonicalHostedTool, originalToolChoice })
  }

  serverToolTrace('prepared', {
    tools: active.map((e) => ({ name: e.toolName, hosted: e.hosted !== undefined })),
  })
  if (active.length === 0) return await run()

  const rewrittenToolChoice = rewriteHostedToolChoice(ctx.payload.tool_choice as ResponsesToolChoiceLoose, active)
  if (rewrittenToolChoice !== (ctx.payload.tool_choice as unknown)) {
    ctx.payload = { ...ctx.payload, tool_choice: rewrittenToolChoice }
  }

  const canonicalInput = (ctx.payload.input as ResponsesInputItem[]) ?? []
  const nextInput = transformServerToolItems(canonicalInput, active)
  if (nextInput !== canonicalInput) ctx.payload = { ...ctx.payload, input: nextInput }

  const hostedActive = active.filter(
    (entry): entry is ActiveServerTool & { hosted: ServerToolHostedDispatch } => entry.hosted !== undefined,
  )
  if (hostedActive.length === 0) return await run()

  const dispatchers = new Map<string, ServerToolDispatcher>()
  for (const entry of hostedActive) dispatchers.set(entry.toolName, entry.hosted.dispatcher)
  const loopState: ServerToolLoopState = {
    iterationCount: 1,
    remainingToolCalls: typeof ctx.payload.max_tool_calls === 'number' ? (ctx.payload.max_tool_calls as number) : undefined,
  }
  const finalToolChoice = ctx.payload.tool_choice as ResponsesToolChoiceLoose
  const demoteForcedServerToolChoiceAfterFirstTurn =
    finalToolChoice === 'required' ||
    (typeof finalToolChoice === 'object' &&
      finalToolChoice !== null &&
      finalToolChoice.type === 'function' &&
      typeof finalToolChoice.name === 'string' &&
      dispatchers.has(finalToolChoice.name))

  const merge = createMergeState()
  const firstResult = await run()
  if (firstResult.type !== 'events') return firstResult
  merge.lastSeenModel = firstResult.modelIdentity.modelKey
  const turn1Iter = consumeTurnStreaming(firstResult.events, merge, true, dispatchers, loopState, active)

  let resolveFinalMetadata!: (m: EventResultMetadata) => void
  const shimFinalMetadata = new Promise<EventResultMetadata>((resolve) => {
    resolveFinalMetadata = resolve
  })
  const incomingModel = gatewayCtx.incomingModel ?? firstResult.modelIdentity.incomingModel
  const metadata: LatestUpstreamMetadata = {
    modelIdentity: retainIncomingModel(firstResult.modelIdentity, incomingModel),
    performance: firstResult.performance,
    resolveModelIdentity: (modelKey) => {
      const resolved = firstResult.resolveModelIdentity?.(modelKey) ?? firstResult.modelIdentity
      return retainIncomingModel(resolved, incomingModel)
    },
  }

  return {
    ...firstResult,
    __interceptorReplaced: true,
    events: runMultiTurnLoop({
      ctx,
      run,
      merge,
      loopState,
      demoteForcedServerToolChoiceAfterFirstTurn,
      turn1Iter,
      dispatchers,
      store,
      canonicalInput,
      active,
      metadata,
      incomingModel,
      resolveFinalMetadata,
    }),
    finalMetadata: shimFinalMetadata,
    resolveModelIdentity: (modelKey) => retainIncomingModel(
      metadata.resolveModelIdentity?.(modelKey) ?? metadata.modelIdentity,
      incomingModel,
    ),
  }
}

// Type-only re-exports the tests / plugin authors need.
export type {
  ServerToolItemAlias,
  ServerToolRegistration,
  ServerToolRequestCtx,
  ServerToolPrepareResult,
  ServerToolDispatcher,
  ServerToolHostedDispatch,
  ServerToolLoopState,
  ServerToolResultSlot,
  ServerToolTerminal,
  ServerToolLifecycleEvent,
  ServerToolOutputItem,
  InterceptedFunctionCall,
  DispatchedServerToolSlot,
}
