/**
 * Parsed-shim-call → `WebSearchCallIR` planning, shared by every web-search
 * shim.
 *
 * One shim `function_call` can carry several operations at once — the tool
 * schema (`shim-tool-schema.ts`) explicitly invites it, and the model was
 * trained on a tool that works that way. Each operation becomes its own search
 * call: `open` and `find` actions carry exactly one url apiece, so they cannot
 * share a call, and a mixed batch has no single action type. The one exception
 * is a batch of `search_query` entries, which collapses into the protocol's
 * native `{type:'search', queries:[…]}` multi-query action.
 *
 * Splitting lives here rather than in either shim so both accept the same
 * argument shapes and fan out the same way, for a model that was prompted with
 * one shared tool schema. Protocol-specific concerns stay with the callers: the
 * Responses plugin adds the per-response iteration cap, the synthesized
 * `web_search_call` ids, and the per-call replay `call_id`s; the Chat
 * Completions interceptor adds its own turn budget and folds the fanned-out
 * results back into one `role:'tool'` message.
 */
import type { ResponsesWebSearchAction } from '@vibe-llm/protocols/responses'
import {
  executeOperationToIr,
  parseWebSearchOperations,
  runBackendSearchMulti,
  schemaErrorIr,
  startBatchFetch,
  type WebSearchCallIR,
  type WebSearchExecutionSession,
  type WebSearchOperation,
  type WebSearchPageFetchMap,
} from './operations.ts'

/**
 * One search call carved out of one shim `function_call`.
 *
 * - `ops` is what this call will execute: several entries only for a
 *   `search_query` batch, one otherwise, none for a malformed call.
 * - `action` is what the call is *about* to do, known without running it.
 *   Native Responses can only name a query once the search resolves, but the
 *   shim issues the search itself — putting the action on the in-progress item
 *   is what lets a client show "searching X" while X is still running. It is
 *   deliberately absent whenever the call will answer with a schema error: an
 *   announced query that never runs is worse than no announcement at all.
 * - `arguments` is the slice of the original call that produced exactly this
 *   one. Each fanned-out call replays as its own `function_call`, so replaying
 *   the whole original object N times would tell the model it asked for
 *   everything N times.
 */
export interface WebSearchCallPlan {
  ops: WebSearchOperation[]
  action?: ResponsesWebSearchAction
  arguments: Record<string, unknown>
}

const subPropertyOf = (op: WebSearchOperation): string => {
  switch (op.kind) {
    case 'search':
      return 'search_query'
    case 'open':
      return 'open'
    case 'find':
      return 'find'
    default:
      return op.subProperty
  }
}

// Rebuilds the caller's own arguments rather than re-serializing the parsed
// operation, so a replayed history shows what the model actually wrote —
// including the fields we ignored and the ones we rejected.
const sliceArguments = (
  args: Record<string, unknown>,
  ops: readonly WebSearchOperation[],
): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const op of ops) {
    const key = subPropertyOf(op)
    const raw = args[key]
    if (op.kind === 'wrong-type' || !Array.isArray(raw)) {
      // A sub-property that isn't an array has no per-entry slice — the whole
      // malformed value *is* what the call was about.
      out[key] = raw
      continue
    }
    const bucket = Array.isArray(out[key]) ? (out[key] as unknown[]) : (out[key] = [])
    bucket.push(raw[op.arrayIndex])
  }
  return out
}

const actionFor = (ops: readonly WebSearchOperation[]): ResponsesWebSearchAction | undefined => {
  const first = ops[0]
  if (first === undefined) return undefined
  // A call that will answer with a schema error has no honest preliminary
  // action: announcing one would show the client a search that never runs.
  if (ops.some((op) => op.kind === 'unsupported' || op.kind === 'wrong-type' || op.error !== undefined)) {
    return undefined
  }

  if (first.kind === 'search') {
    const queries = (ops as Array<Extract<WebSearchOperation, { kind: 'search' }>>).map((op) => op.query)
    return { type: 'search', query: queries.join(' | '), queries }
  }
  // `open`/`find` name exactly one url apiece, so they never share a call.
  if (ops.length > 1) return undefined
  if (first.kind === 'open') return { type: 'open_page', url: first.url }
  if (first.kind === 'find') return { type: 'find_in_page', url: first.url, pattern: first.pattern }
  return undefined
}

const planFor = (
  args: Record<string, unknown>,
  ops: WebSearchOperation[],
): WebSearchCallPlan => {
  const action = actionFor(ops)
  return {
    ops,
    ...(action !== undefined ? { action } : {}),
    arguments: sliceArguments(args, ops),
  }
}

/**
 * Carve one shim call's arguments into the independent calls it asked for.
 * Pure: nothing runs until `runWebSearchCallPlan`.
 *
 * Always returns at least one plan — a call with nothing runnable in it still
 * owes the model a `web_search_call` explaining why.
 */
export const splitWebSearchCalls = (args: Record<string, unknown> | null): WebSearchCallPlan[] => {
  const parsed = parseWebSearchOperations(args)
  const source = args ?? {}
  if (parsed.kind === 'malformed' || parsed.ops.length === 0) {
    return [{ ops: [], arguments: source }]
  }

  const plans: WebSearchCallPlan[] = []
  // Clean `search_query` entries all join the first one's plan; every other
  // operation — including a search entry that failed to parse — gets its own,
  // so one bad entry no longer makes the model resend the good ones.
  let searchBatch: WebSearchOperation[] | undefined
  for (const op of parsed.ops) {
    if (op.kind === 'search' && op.error === undefined) {
      if (searchBatch === undefined) {
        searchBatch = [op]
        plans.push({ ops: searchBatch, arguments: {} })
      } else {
        searchBatch.push(op)
      }
      continue
    }
    plans.push({ ops: [op], arguments: {} })
  }
  return plans.map((plan) => planFor(source, plan.ops))
}

/**
 * Page fetches are batched across every plan from one shim call: two `open`s
 * and a `find` on the same url cost one upstream fetch, not three.
 */
export const startWebSearchCallFetches = (
  plans: readonly WebSearchCallPlan[],
  session: WebSearchExecutionSession,
): Promise<WebSearchPageFetchMap> =>
  startBatchFetch({ kind: 'ops', ops: plans.flatMap((plan) => plan.ops) }, session)

export const runWebSearchCallPlan = async (
  plan: WebSearchCallPlan,
  session: WebSearchExecutionSession,
  fetches: Promise<WebSearchPageFetchMap>,
): Promise<WebSearchCallIR> => {
  if (plan.ops.length === 0) {
    return schemaErrorIr(
      'malformed shim call arguments',
      'Malformed arguments',
      'Error: arguments must be a JSON object with sub-property arrays (search_query[], open[], find[]).',
    )
  }
  if (plan.ops.length > 1) {
    return runBackendSearchMulti(
      plan.ops as Array<Extract<WebSearchOperation, { kind: 'search' }>>,
      session,
    )
  }
  return executeOperationToIr(plan.ops[0]!, session, await fetches)
}

/** Split, then start every call. Both shims enter here. */
export const planWebSearchCalls = (
  args: Record<string, unknown> | null,
  session: WebSearchExecutionSession,
): Array<WebSearchCallPlan & { promise: Promise<WebSearchCallIR> }> => {
  const plans = splitWebSearchCalls(args)
  const fetches = startWebSearchCallFetches(plans, session)
  return plans.map((plan) => ({ ...plan, promise: runWebSearchCallPlan(plan, session, fetches) }))
}
