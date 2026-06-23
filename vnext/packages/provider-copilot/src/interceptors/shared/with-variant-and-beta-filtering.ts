// src/providers/copilot/interceptors/shared/with-variant-and-beta-filtering.ts
import type { AccountType } from "../../account-type"
import { getCachedRawModels } from "../../raw-models-cache"
import {
  filterAnthropicBetaForUpstream,
  hasContext1mBeta,
  parseAnthropicBeta,
  parseCompositeModelId,
  resolveCopilotRawModel,
} from "../../variants"
import type { CopilotInterceptor, Invocation } from "@vnext/protocols/common"

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
 * Factory closure: copilotToken + accountType are CopilotProvider instance
 * state that the interceptor needs for getCachedRawModels(). Keeping them out
 * of the Invocation contract preserves portability — other providers don't
 * need to know Copilot's variant catalog exists.
 */
export const createVariantAndBetaFilteringInterceptor = (
  copilotToken: string,
  accountType: AccountType,
): CopilotInterceptor => {
  return async (inv, _ctx, run) => {
    const kind = KIND_BY_ENDPOINT[inv.endpoint]
    if (kind !== null && kind !== undefined) {
      await applyVariantAndBetaFiltering(inv, kind, copilotToken, accountType)
    }
    return run()
  }
}

const applyVariantAndBetaFiltering = async (
  inv: Invocation,
  kind: VariantKind,
  copilotToken: string,
  accountType: AccountType,
): Promise<void> => {
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

  if (modelId?.startsWith("claude-") && copilotToken) {
    try {
      const rawModels = await getCachedRawModels(copilotToken, accountType)
      const resolved = resolveCopilotRawModel(rawModels, modelId, {
        context1m: wantContext1m,
        reasoningEffort: effectiveEffort,
      })
      if (resolved !== modelId) payload.model = resolved
    } catch (e) {
      console.error("[variants] resolve failed:", e)
    }
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
