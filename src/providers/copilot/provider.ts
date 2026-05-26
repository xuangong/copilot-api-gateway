import type { AccountType } from "~/config/constants"
import { callCopilotAPI } from "~/services/copilot/forward"
import { getModels, type ModelsResponse } from "~/services/copilot/models"
import { getCachedRawModels } from "~/services/copilot/raw-models-cache"
import {
  filterAnthropicBetaForUpstream,
  hasContext1mBeta,
  parseAnthropicBeta,
  parseCompositeModelId,
  resolveCopilotRawModel,
} from "~/services/copilot/variants"

import type { ModelProvider, ProbeResult, ProviderCallOptions } from "../types"
import { probeViaModels } from "../probe"

export interface CopilotProviderConfig {
  copilotToken: string
  accountType: AccountType
  name?: string
}

type EndpointKind = "messages" | "chat_completions" | "responses" | "embeddings"

export class CopilotProvider implements ModelProvider {
  readonly kind = "copilot" as const
  readonly name: string
  private readonly copilotToken: string
  private readonly accountType: AccountType

  constructor(cfg: CopilotProviderConfig) {
    this.copilotToken = cfg.copilotToken
    this.accountType = cfg.accountType
    this.name = cfg.name ?? "copilot"
  }

  getModels(): Promise<ModelsResponse> {
    return getModels(this.copilotToken, this.accountType)
  }

  probe(): Promise<ProbeResult> {
    return probeViaModels(() => this.getModels())
  }

  callChatCompletions(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.call("/chat/completions", payload, opts, "call Chat Completions", { kind: "chat_completions" })
  }

  callResponses(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.call("/responses", payload, opts, "call Responses", { kind: "responses" })
  }

  callMessages(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.call("/v1/messages", payload, opts, "call Messages", { kind: "messages" })
  }

  callMessagesCountTokens(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.call("/v1/messages/count_tokens", payload, opts, "count tokens", { kind: "messages", requireModel: false })
  }

  callEmbeddings(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.call("/embeddings", payload, opts, "create embeddings", { kind: "embeddings" })
  }

  private async call(
    endpoint: string,
    payload: Record<string, unknown>,
    opts: ProviderCallOptions,
    defaultOpName: string,
    cfg: { kind: EndpointKind; requireModel?: boolean },
  ): Promise<Response> {
    const headers = { ...(opts.extraHeaders ?? {}) }
    if (cfg.kind !== "embeddings") {
      await this.applyVariantAndBetaFiltering(payload, headers, cfg.kind)
    }

    return callCopilotAPI({
      endpoint,
      payload,
      operationName: opts.operationName ?? defaultOpName,
      copilotToken: this.copilotToken,
      accountType: this.accountType,
      timeout: opts.timeout,
      extraHeaders: headers,
      requireModel: cfg.requireModel,
    })
  }

  /**
   * For Claude requests, rewrite `payload.model` to the raw Copilot variant id
   * (e.g. claude-opus-4.7 → claude-opus-4.7-1m-internal) based on
   * `anthropic-beta: context-1m-2025-08-07` and the endpoint's effort field,
   * and filter `anthropic-beta` through Copilot's allowlist.
   *
   * Two extra client-side shortcuts are honored so clients that can't set
   * protocol-native effort fields (e.g. Claude Code only sets ANTHROPIC_MODEL
   * and ANTHROPIC_CUSTOM_HEADERS) can still pick context/effort:
   *
   * 1. Composite model id: `claude-opus-4.7-xhigh-1m` → parsed into
   *    {baseId, effort:"xhigh", context1m:true}
   * 2. Header `x-copilot-reasoning-effort: xhigh` → effort hint + injected
   *    into payload's protocol-native field
   *
   * Both are stripped/normalized before forwarding so upstream never sees them.
   */
  private async applyVariantAndBetaFiltering(
    payload: Record<string, unknown>,
    headers: Record<string, string>,
    kind: Exclude<EndpointKind, "embeddings">,
  ): Promise<void> {
    const rawModelId = typeof payload.model === "string" ? payload.model : undefined

    const betaHeader = headers["anthropic-beta"] ?? headers["Anthropic-Beta"]
    const clientBeta = parseAnthropicBeta(betaHeader)

    const headerEffort = consumeReasoningEffortHeader(headers)
    const parsedComposite = rawModelId ? parseCompositeModelId(rawModelId) : undefined
    const compositeEffort = parsedComposite?.effort
    const compositeContext1m = parsedComposite?.context1m === true

    // Rewrite payload.model to the base id so downstream resolution and
    // payload-effort injection both see the canonical name.
    if (parsedComposite && parsedComposite.baseId !== rawModelId) {
      payload.model = parsedComposite.baseId
    }

    const payloadEffort = extractEffort(payload, kind)
    // Priority: composite-id suffix > payload native field > header.
    const effectiveEffort = compositeEffort ?? payloadEffort ?? headerEffort
    if (effectiveEffort && effectiveEffort !== payloadEffort) {
      injectEffort(payload, kind, effectiveEffort)
    }

    const wantContext1m = hasContext1mBeta(clientBeta) || compositeContext1m

    const modelId = typeof payload.model === "string" ? payload.model : undefined

    if (modelId?.startsWith("claude-") && this.copilotToken) {
      try {
        const rawModels = await getCachedRawModels(this.copilotToken, this.accountType)
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
      const mergedBeta = compositeContext1m && !clientBeta.includes("context-1m-2025-08-07")
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
}

function consumeReasoningEffortHeader(headers: Record<string, string>): string | undefined {
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

function injectEffort(
  payload: Record<string, unknown>,
  kind: Exclude<EndpointKind, "embeddings">,
  effort: string,
): void {
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
  // responses
  const r = (payload as { reasoning?: { effort?: string } }).reasoning ?? {}
  r.effort = effort
  ;(payload as { reasoning?: { effort?: string } }).reasoning = r
}

function extractEffort(
  payload: Record<string, unknown>,
  kind: Exclude<EndpointKind, "embeddings">,
): string | undefined {
  if (kind === "messages") {
    const oc = (payload as { output_config?: { effort?: string } }).output_config
    return oc?.effort
  }
  if (kind === "chat_completions") {
    const e = (payload as { reasoning_effort?: string }).reasoning_effort
    return e && e !== "none" ? e : undefined
  }
  // responses
  const r = (payload as { reasoning?: { effort?: string } }).reasoning
  return r?.effort && r.effort !== "none" ? r.effort : undefined
}

function hasThinkingBudget(payload: Record<string, unknown>): boolean {
  const t = (payload as { thinking?: { budget_tokens?: number } }).thinking
  return typeof t?.budget_tokens === "number" && t.budget_tokens > 0
}

function isAdaptiveThinking(payload: Record<string, unknown>): boolean {
  const t = (payload as { thinking?: { type?: string } }).thinking
  return t?.type === "adaptive"
}
