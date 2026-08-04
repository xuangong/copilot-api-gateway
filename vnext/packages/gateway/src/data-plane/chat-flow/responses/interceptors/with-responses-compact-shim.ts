// Compact-shim — simulates a `response.compaction` envelope against upstreams
// that have no native compaction wire.
//
// Adapted from copilot-gateway
// `packages/gateway/src/data-plane/chat/responses/interceptors/compact-shim.ts`.
//
// Engagement is the OR of two conditions:
//   1. The per-upstream `responses-compact-shim` flag is on. This is the
//      operator-controlled opt-in for Responses-target upstreams that
//      already answer a compact request themselves — natively through
//      `/responses/compact` (codex / azure / custom), or by replaying
//      `RemoteCompactionV2` over `/responses` (copilot) — but where we still
//      want shim-synthesized envelopes.
//   2. The candidate's target endpoint is not `responses`. When the upstream
//      is Messages or Chat Completions, the translation layer has no concept
//      of a `compaction` output item or a `compaction_trigger` input item.
//      The shim is structurally required regardless of the flag — without
//      it, a `compaction_trigger` item would reach the translator and
//      crash on the unknown variant.
//
// Inner compact-shape detection is also the OR of two conditions:
//   - `invocation.action === 'compact'` (the native `/responses/compact`
//     entry point), or
//   - `invocation.payload.input` contains a `compaction_trigger` item
//     (Codex CLI's RemoteCompactionV2 path: a `generate` call whose input
//     ends in a control item that semantically requests compaction).
//
// Flow when engaged and compact-shaped:
//   1. Inbound: walk `payload.input` for `compaction` items whose
//      `encrypted_content` decodes as our base64url-JSON marker. Each match
//      is replaced inline with the items it originally encoded — so a
//      subsequent turn that echoes back the synthesized compaction sees the
//      summarized history.
//   2. Outbound: pivot the action to 'generate', prepend a role=system
//      message carrying the SUMMARIZATION_PROMPT (vendored from
//      openai/codex), strip any `compaction_trigger` items, append a
//      terminal user message if the history ends on a non-user item
//      (Anthropic Messages rejects assistant prefill), and force
//      `store: false` so the ephemeral summarization turn does not
//      pollute the upstream's conversation history.
//
// Foreign-upstream blobs (opaque strings that fail base64url+JSON decoding
// or fail the array-of-objects-with-string-types schema below) round-trip
// untouched, so the operator can selectively turn the flag off for the
// codex / copilot / azure / custom upstreams that answer compact themselves.
import type { ResponsesInterceptor } from './types'
import { decodeBase64UrlJson, encodeBase64UrlJson } from '../../../../shared/base64url-json.ts'
import { isJsonObject } from '../../shared/json-helpers'
import {
  createRandomResponsesItemId,
  responsesResultToEvents,
  type CanonicalResponsesPayload,
  type ResponsesInputItem,
  type ResponsesOutputItem,
  type ResponsesResult,
  type ResponsesStreamEvent,
} from '@vibe-llm/protocols/responses'
import type { LlmExecuteResult } from '@vibe-llm/protocols/common'
import type { ProtocolFrame } from '@vibe-core/result'
import { collectResponsesProtocolEventsToResult } from '../events/reassemble'

// The two vendored constants below (SUMMARIZATION_PROMPT and SUMMARY_PREFIX)
// are the compactor system prompt and the handoff prefix openai/codex ships
// for local remote-v2 compaction. Both are also the exact strings Copilot's
// server-side compactor uses today — confirmed by prompt-injection
// extraction against the live upstream. Bumps to openai/codex's
// `compact/prompt.md` or `compact/summary_prefix.md` are the signal to bump
// these constants.

// Vendored from openai/codex (Apache-2.0):
// https://github.com/openai/codex/blob/ba2b67f9cda954bcdda43c2a65ac58e807b996bd/codex-rs/prompts/templates/compact/prompt.md
const SUMMARIZATION_PROMPT
  = 'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\n'
  + 'Include:\n'
  + '- Current progress and key decisions made\n'
  + '- Important context, constraints, or user preferences\n'
  + '- What remains to be done (clear next steps)\n'
  + '- Any critical data, examples, or references needed to continue\n\n'
  + 'Be concise, structured, and focused on helping the next LLM seamlessly continue the work.'

// Vendored from openai/codex (Apache-2.0):
// https://github.com/openai/codex/blob/ba2b67f9cda954bcdda43c2a65ac58e807b996bd/codex-rs/prompts/templates/compact/summary_prefix.md
const SUMMARY_PREFIX
  = 'Another language model started to solve this problem and produced a summary of its thinking process.'
  + ' You also have access to the state of the tools that were used by that language model. Use this to'
  + ' build on the work that has already been done and avoid duplicating work. Here is the summary produced'
  + ' by the other language model, use the information in this summary to assist with your own analysis:'

export { SUMMARIZATION_PROMPT, SUMMARY_PREFIX }

type ResponsesRunResult = LlmExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
type ChainRun = () => Promise<ResponsesRunResult>

// ── Inbound expansion ─────────────────────────────────────────────────────────

// Structural validator: a shim payload is an array of input-item objects each
// carrying a `type` field. Strict enough that a foreign opaque blob can't
// accidentally decode + parse + validate.
const isShimCompactionPayload = (value: unknown): value is ResponsesInputItem[] =>
  Array.isArray(value) && value.every(item =>
    isJsonObject(item) && typeof (item as { type?: unknown }).type === 'string')

export const expandShimCompactionItems = (payload: CanonicalResponsesPayload): CanonicalResponsesPayload => {
  const rewritten: ResponsesInputItem[] = []
  let changed = false
  for (const item of payload.input) {
    if (item.type !== 'compaction') {
      rewritten.push(item)
      continue
    }
    const encryptedContent = (item as { encrypted_content?: unknown }).encrypted_content
    if (typeof encryptedContent !== 'string') {
      rewritten.push(item)
      continue
    }
    const decoded = decodeBase64UrlJson(encryptedContent)
    if (!isShimCompactionPayload(decoded)) {
      // Foreign blob — leave untouched so a native-compaction upstream still
      // sees its own encrypted_content verbatim.
      rewritten.push(item)
      continue
    }
    rewritten.push(...decoded)
    changed = true
  }
  return changed ? { ...payload, input: rewritten } : payload
}

// ── Outbound summarization ────────────────────────────────────────────────────

// A turn that closed nothing falls back to the terminal-envelope's stated
// `output`, as the client-facing egress does.
const summaryTextFrom = (
  closed: Map<number, ResponsesOutputItem>,
  stated: readonly ResponsesOutputItem[],
): string => {
  const items = closed.size === 0
    ? stated
    : [...closed].sort(([left], [right]) => left - right).map(([, item]) => item)
  const parts: string[] = []
  for (const item of items) {
    if (item.type !== 'message') continue
    for (const block of item.content) {
      if (block.type === 'output_text') parts.push(block.text)
    }
  }
  return parts.join('')
}

const buildCompactionEnvelope = (
  cmpId: string,
  summaryText: string,
  upstream: ResponsesResult,
): ResponsesResult => {
  // Prefix lives inside the blob so it round-trips atomically with the
  // summary — a downstream LLM sees `${SUMMARY_PREFIX}\n${summaryText}` in
  // one message and reads it as "another LLM's handoff", not as the human
  // speaking.
  const summaryItem: ResponsesInputItem = {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: `${SUMMARY_PREFIX}\n${summaryText}` }],
  }
  const encryptedContent = encodeBase64UrlJson([summaryItem])

  const { output_text: _droppedOutputText, ...upstreamBase } = upstream

  // `status`, `incomplete_details`, and `error` flow through verbatim from
  // the spread: a summarization turn that hit `max_output_tokens` returns
  // `status: 'incomplete'` with `incomplete_details.reason` set; an
  // upstream-side failure returns `status: 'failed'` with `error` populated.
  return {
    ...upstreamBase,
    id: `resp_compact_shim_${crypto.randomUUID()}`,
    object: 'response.compaction',
    output: [
      {
        type: 'compaction',
        id: cmpId,
        encrypted_content: encryptedContent,
      },
    ] as unknown as ResponsesResult['output'],
  }
}

// Synthesize a full lifecycle event stream around the compaction envelope so
// the terminal event carries the envelope through `withUpstreamTelemetry`'s
// classifier. Reuses `responsesResultToEvents({ genericOutputItems: true })`
// so the compaction output item is emitted through the bare
// `output_item.added`/`output_item.done` envelope (no inner content_part
// expansion, since it isn't message-shaped).
const syntheticEventsFromResult = async function* (
  result: ResponsesResult,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  for (const frame of responsesResultToEvents(result, { genericOutputItems: true })) yield frame
}

const simulateCompaction = async (
  inv: Parameters<ResponsesInterceptor>[0],
  run: ChainRun,
): Promise<ResponsesRunResult> => {
  const originalPayload = inv.payload as unknown as CanonicalResponsesPayload

  // Strip compaction_trigger so the upstream sees a plain generate turn
  // against SUMMARIZATION_PROMPT.
  const historyItems = originalPayload.input.filter(item => (item as { type: string }).type !== 'compaction_trigger')

  // Anthropic Messages rejects assistant prefill — when the translated
  // conversation ends on an assistant message, the upstream returns 400.
  // Append a synthetic terminal user message that nudges the model into
  // producing the summary. Harmless on OpenAI-style upstreams.
  //
  // Wrap the nudge in `<system-reminder>…</system-reminder>` — Claude Code's
  // convention for injecting synthetic system-level context into a
  // `user`-role message without it reading as a literal user instruction.
  const terminalUserMessage: ResponsesInputItem = {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '<system-reminder>Produce the handoff summary now per the instructions above.</system-reminder>' }],
  }

  // SUMMARIZATION_PROMPT rides as a role=system input item at the head of
  // the history — always injected, never overridable. The caller's original
  // `instructions` flows through unchanged. Non-Responses targets (Messages,
  // Chat Completions) downgrade both layers onto a single top-level system
  // slot; that's a strict native capability gap, not a shim regression.
  const compactorSystemMessage: ResponsesInputItem = {
    type: 'message',
    role: 'system',
    content: [{ type: 'input_text', text: SUMMARIZATION_PROMPT }],
  }
  const inputForSummarization = [compactorSystemMessage, ...historyItems, terminalUserMessage]

  inv.payload = {
    ...originalPayload,
    input: inputForSummarization,
    // Do not persist the ephemeral summarization turn in the upstream's
    // conversation history.
    store: false,
  } as unknown as typeof inv.payload

  // Pivot the action so the inner dispatch routes to the upstream's
  // generate wire instead of its compact wire. The mutation is one-way:
  // every `ctx.*` write propagates downstream and is never restored on the
  // way out.
  inv.action = 'generate'

  const upstreamResult = await run()

  if (upstreamResult.type !== 'events') {
    // api-error / internal-error from the upstream propagate so the client
    // learns the compaction failed rather than receiving a silent empty
    // envelope.
    return upstreamResult
  }

  const closedItems = new Map<number, ResponsesOutputItem>()
  const observed = (async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    for await (const frame of upstreamResult.events) {
      if (frame.type === 'event' && frame.event.type === 'response.output_item.done') {
        closedItems.set(frame.event.output_index, frame.event.item)
      }
      yield frame
    }
  })()

  const collected = await collectResponsesProtocolEventsToResult(observed)
  const summaryText = summaryTextFrom(closedItems, collected.output)
  // A compaction blob is the whole of what the next turn inherits, so an
  // empty one silently discards the conversation.
  if (summaryText.length === 0) {
    throw new Error('Responses compact shim: the summarization turn closed no assistant text to summarize')
  }
  const cmpId = createRandomResponsesItemId('compaction')
  const synthesized = buildCompactionEnvelope(cmpId, summaryText, collected)

  return {
    ...upstreamResult,
    events: syntheticEventsFromResult(synthesized),
  }
}

export const containsCompactionTrigger = (input: readonly ResponsesInputItem[]): boolean =>
  input.some(item => (item as { type: string }).type === 'compaction_trigger')

export const withResponsesCompactShim: ResponsesInterceptor = async (inv, ctx, run) => {
  // The shim is engaged when the operator turned it on for this upstream,
  // OR when the target endpoint is not Responses (Messages / Chat
  // Completions have no compaction wire and would crash on the unknown
  // `compaction_trigger` input variant).
  const flagOn = inv.enabledFlags.has('responses-compact-shim')
  const structurallyRequired = ctx.targetEndpoint !== undefined && ctx.targetEndpoint !== 'responses'
  if (!flagOn && !structurallyRequired) return run()

  // Inbound: expand any prior shim-encoded compactions back into their
  // original items so the upstream sees the summarized history.
  const canonical = inv.payload as unknown as CanonicalResponsesPayload
  inv.payload = expandShimCompactionItems(canonical) as unknown as typeof inv.payload

  // Compact-shaped requests are either the native `/responses/compact`
  // action or a `generate` call whose input ends in a `compaction_trigger`.
  const expandedInput = (inv.payload as unknown as CanonicalResponsesPayload).input
  const isCompactShaped = inv.action === 'compact' || containsCompactionTrigger(expandedInput)
  if (!isCompactShaped) return run()

  return simulateCompaction(inv, run)
}
