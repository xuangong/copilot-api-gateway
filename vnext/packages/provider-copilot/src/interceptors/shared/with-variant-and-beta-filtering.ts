// src/providers/copilot/interceptors/shared/with-variant-and-beta-filtering.ts
import type { AccountType } from "../../account-type"
import { getCachedRawModels } from "../../raw-models-cache"
import { adaptThinkingForModel } from "../../transforms/thinking-cleanup"
import type { AnthropicMessagesPayload } from "../../transforms/types"
import {
  filterAnthropicBetaForUpstream,
  hasContext1mBeta,
  parseAnthropicBeta,
  parseCompositeModelId,
  selectCopilotVariant,
  type CopilotVariantSelection,
  thinkingCapabilitiesFor,
} from "../../variants"
import type { CopilotInterceptor, Invocation } from "@vibe-llm/protocols/common"
import type { Fetcher } from "@vibe-core/upstream"

type VariantKind = "messages" | "chat_completions" | "responses"

const KIND_BY_ENDPOINT: Record<string, VariantKind | null> = {
  messages: "messages",
  messages_count_tokens: "messages",
  chat_completions: "chat_completions",
  responses: "responses",
  embeddings: null,
  images_generations: null,
  images_edits: null,
}

/**
 * Vendor-specific interceptor: rewrites payload.model to a Copilot raw variant
 * id (e.g. claude-opus-4.7 → claude-opus-4.7-1m-internal) and filters the
 * anthropic-beta header through Copilot's allowlist.
 *
 * Factory closure: copilotToken + accountType + baseUrl + fetcher are
 * CopilotProvider instance state that the interceptor needs for
 * getCachedRawModels(). The fetcher carries the upstream's egress proxy chain,
 * so variant resolution leaves the host the same way inference does. Keeping
 * them out of the Invocation contract preserves portability — other providers
 * don't need to know Copilot's variant catalog exists.
 *
 * The session is read through getters rather than captured by value: the
 * provider swaps its token and base URL in place when the upstream rejects a
 * revoked session (provider.ts withAuthRetry), and a by-value capture here
 * would keep resolving variants with the dead token for the life of the
 * provider.
 */
export const createVariantAndBetaFilteringInterceptor = (
  getCopilotToken: () => string,
  accountType: AccountType,
  getBaseUrl: () => string | undefined,
  fetcher?: Fetcher,
  onSelection?: (selection: CopilotVariantSelection) => void,
  sourceProtocol?: string,
): CopilotInterceptor => {
  return async (inv, _ctx, run) => {
    const kind = KIND_BY_ENDPOINT[inv.endpoint]
    if (kind !== null && kind !== undefined) {
      const error = await applyVariantAndBetaFiltering(inv, kind, getCopilotToken(), accountType, getBaseUrl(), fetcher, onSelection, sourceProtocol)
      if (error) return error
    }
    return run()
  }
}

const applyVariantAndBetaFiltering = async (
  inv: Invocation,
  kind: VariantKind,
  copilotToken: string,
  accountType: AccountType,
  baseUrl?: string,
  fetcher?: Fetcher,
  onSelection?: (selection: CopilotVariantSelection) => void,
  sourceProtocol?: string,
): Promise<Response | undefined> => {
  const { payload, headers } = inv
  const rawModelId = typeof payload.model === "string" ? payload.model : undefined

  const betaHeader = headers["anthropic-beta"] ?? headers["Anthropic-Beta"]
  const clientBeta = parseAnthropicBeta(betaHeader)

  const headerEffort = consumeReasoningEffortHeader(headers)
  const parsedComposite = rawModelId ? parseCompositeModelId(rawModelId) : undefined
  const compositeEffort = parsedComposite?.effort
  const compositeContext1m = parsedComposite?.context1m === true

  if (parsedComposite && parsedComposite.baseId !== rawModelId) {
    payload.model = parsedComposite.baseId
  }

  const payloadEffort = extractEffort(payload, kind)
  const effectiveEffort = compositeEffort ?? payloadEffort ?? headerEffort
  if (effectiveEffort && effectiveEffort !== payloadEffort) {
    injectEffort(payload, kind, effectiveEffort)
  }

  const wantContext1m = hasContext1mBeta(clientBeta) || compositeContext1m
  const modelId = typeof payload.model === "string" ? payload.model : undefined

  const wantFast = payload.speed === "fast" || payload.service_tier === "priority"
  const requiresFast = wantFast && (sourceProtocol === "messages" || (!sourceProtocol && kind === "messages"))
  let selection: CopilotVariantSelection | undefined
  if (modelId && copilotToken && (modelId.startsWith("claude-") || wantFast || modelId.endsWith("-fast"))) {
    try {
      const rawModels = await getCachedRawModels(copilotToken, accountType, baseUrl, fetcher)
      const exactPin = rawModels.data.find(model => model.id === rawModelId)
      selection = selectCopilotVariant(rawModels, exactPin?.id ?? modelId, inv.endpoint, {
        context1m: wantContext1m, reasoningEffort: effectiveEffort, fast: wantFast,
      })
      const resolved = selection.modelKey
      payload.model = resolved
      // Thinking adaptation lives here, not in its own interceptor, because
      // this is the only place holding the raw_models catalog — and because
      // the anthropic-beta decision below reads `thinking.type`, so it has to
      // see the adapted payload, not the client's original shape.
      if (kind === "messages") {
        adaptThinkingForModel(
          payload as unknown as AnthropicMessagesPayload,
          thinkingCapabilitiesFor(rawModels, resolved),
        )
      }
    } catch {
      console.warn("[variants] catalog unavailable")
    }
  }

  if (requiresFast && inv.endpoint !== "messages_count_tokens" && selection?.serviceTier !== "priority") {
    return Response.json({ type: "error", error: { type: "invalid_request_error", message: "Fast mode is not supported for this model and endpoint." } }, { status: 400 })
  }
  if (inv.endpoint !== "messages_count_tokens" && modelId) {
    onSelection?.(selection ?? { modelKey: typeof payload.model === "string" ? payload.model : modelId, serviceTier: "default" })
    if (payload.speed === "fast" || payload.speed === "standard") delete payload.speed
    if (kind === "chat_completions") delete payload.service_tier
  }

  if (betaHeader !== undefined || compositeContext1m) {
    const mergedBeta =
      compositeContext1m && !clientBeta.includes("context-1m-2025-08-07")
        ? [...clientBeta, "context-1m-2025-08-07"]
        : clientBeta
    const filtered = filterAnthropicBetaForUpstream(mergedBeta, {
      thinkingBudgetTokens: kind === "messages" && hasThinkingBudget(payload),
      isAdaptiveThinking: kind === "messages" && isAdaptiveThinking(payload),
    })
    delete headers["anthropic-beta"]
    delete headers["Anthropic-Beta"]
    if (filtered.length > 0) headers["anthropic-beta"] = filtered.join(",")
  }
  return undefined
}

const consumeReasoningEffortHeader = (headers: Record<string, string>): string | undefined => {
  const variants = ["x-copilot-reasoning-effort", "X-Copilot-Reasoning-Effort"]
  let value: string | undefined
  for (const name of variants) {
    if (headers[name] !== undefined) {
      value = value ?? headers[name]
      delete headers[name]
    }
  }
  const trimmed = value?.trim()
  return trimmed && trimmed !== "none" ? trimmed : undefined
}

const injectEffort = (
  payload: Record<string, unknown>,
  kind: VariantKind,
  effort: string,
): void => {
  if (kind === "messages") {
    const oc = (payload as { output_config?: { effort?: string } }).output_config ?? {}
    oc.effort = effort
    ;(payload as { output_config?: { effort?: string } }).output_config = oc
    return
  }
  if (kind === "chat_completions") {
    ;(payload as { reasoning_effort?: string }).reasoning_effort = effort
    return
  }
  const r = (payload as { reasoning?: { effort?: string } }).reasoning ?? {}
  r.effort = effort
  ;(payload as { reasoning?: { effort?: string } }).reasoning = r
}

const extractEffort = (
  payload: Record<string, unknown>,
  kind: VariantKind,
): string | undefined => {
  if (kind === "messages") {
    return (payload as { output_config?: { effort?: string } }).output_config?.effort
  }
  if (kind === "chat_completions") {
    const e = (payload as { reasoning_effort?: string }).reasoning_effort
    return e && e !== "none" ? e : undefined
  }
  const r = (payload as { reasoning?: { effort?: string } }).reasoning
  return r?.effort && r.effort !== "none" ? r.effort : undefined
}

const hasThinkingBudget = (payload: Record<string, unknown>): boolean => {
  const t = (payload as { thinking?: { budget_tokens?: number } }).thinking
  return typeof t?.budget_tokens === "number" && t.budget_tokens > 0
}

const isAdaptiveThinking = (payload: Record<string, unknown>): boolean => {
  const t = (payload as { thinking?: { type?: string } }).thinking
  return t?.type === "adaptive"
}
