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
import { type EndpointKey } from "~/protocols/common"
import type { ProviderFetchOptions } from "../types"

export interface CopilotProviderConfig {
  copilotToken: string
  accountType: AccountType
  name?: string
}

type EndpointKind = "messages" | "chat_completions" | "responses" | "embeddings"

const COPILOT_PATHS: Record<EndpointKey, string> = {
  chat_completions: "/chat/completions",
  responses: "/responses",
  messages: "/v1/messages",
  messages_count_tokens: "/v1/messages/count_tokens",
  embeddings: "/embeddings",
}

const COPILOT_SUPPORTED: readonly EndpointKey[] = [
  "chat_completions",
  "responses",
  "messages",
  "messages_count_tokens",
  "embeddings",
]

/** Maps each endpoint to the variant-filtering kind. embeddings = null (no filtering). */
const VARIANT_KIND: Record<EndpointKey, EndpointKind | null> = {
  chat_completions: "chat_completions",
  responses: "responses",
  messages: "messages",
  messages_count_tokens: "messages",
  embeddings: null,
}

export class CopilotProvider implements ModelProvider {
  readonly kind = "copilot" as const
  readonly name: string
  readonly supportedEndpoints = COPILOT_SUPPORTED
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

  async fetch(endpoint: EndpointKey, init: RequestInit, opts: ProviderFetchOptions = {}): Promise<Response> {
    const path = COPILOT_PATHS[endpoint]
    if (!path) throw new Error(`CopilotProvider does not support endpoint: ${endpoint}`)

    const payload = parseJsonBody(init.body)
    const headers = mergeHeaders(init.headers, opts.extraHeaders)

    const variantKind = VARIANT_KIND[endpoint]
    if (variantKind !== null) {
      await this.applyVariantAndBetaFiltering(payload, headers, variantKind as Exclude<EndpointKind, "embeddings">)
    }

    const requireModel = opts.requireModel ?? (endpoint !== "messages_count_tokens")

    return callCopilotAPI({
      endpoint: path,
      payload,
      operationName: opts.operationName ?? `call ${endpoint}`,
      copilotToken: this.copilotToken,
      accountType: this.accountType,
      timeout: opts.timeout,
      extraHeaders: headers,
      requireModel,
    })
  }

  callEmbeddings(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.fetch("embeddings", { method: "POST", body: JSON.stringify(payload) }, opts)
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

function parseJsonBody(body: BodyInit | null | undefined): Record<string, unknown> {
  if (typeof body !== "string") {
    throw new Error("CopilotProvider.fetch: body must be a JSON string")
  }
  return JSON.parse(body) as Record<string, unknown>
}

function mergeHeaders(
  initHeaders: HeadersInit | undefined,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (initHeaders) {
    const h = new Headers(initHeaders)
    h.forEach((v, k) => { out[k] = v })
  }
  if (extra) Object.assign(out, extra)
  return out
}
