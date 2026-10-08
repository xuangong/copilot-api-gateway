/**
 * ClaudeCodeProvider — LlmModelProvider implementation over the Anthropic
 * /v1/messages backend on a Claude Code subscription OAuth bearer.
 *
 * vNext adaptations vs reference:
 *   - Factory function replaced with a class implementing LlmModelProvider.
 *   - Single endpoint 'messages'.
 *   - Access-token / catalog / pricing routing lives on the class methods.
 */
import { ClaudeCodeCredentialUnavailableError, ensureClaudeCodeAccessToken } from './access-token'
import { ClaudeCodeOAuthSessionTerminatedError } from './auth/oauth'
import { assertClaudeCodeUpstreamRecord } from './config'
import { isClaudeCodeShapedRequest } from './detection'
import { callClaudeCodeMessagesPrepared, type ClaudeCodePreparedCallResult } from './fetch'
import { readClaudeCodeCredential } from './credential-effects'
import {
  assertClaudeCodeExecutionAuthority,
  claudeCodeAffinityTarget,
  ClaudeCodeAffinityChangedError,
  type ClaudeCodeExecutionAuthority,
} from './affinity-execution'
import { directFetcher, type Fetcher } from './fetcher'
import {
  CLAUDE_CODE_MESSAGES_BOUNDARY,
  type MessagesBoundaryCtx,
} from './interceptors/messages'
import {
  buildClaudeCodeCatalog,
  fetchClaudeCodeModelsList,
  type ClaudeCodeProviderModel,
} from './models'
import { pricingForClaudeCodeModelKey } from './pricing'
import { assertClaudeCodeUpstreamState } from './state'
import { runInterceptors } from '@vibe-core/service'
import { UpstreamGoneError, UpstreamReplacedError } from '@vibe-core/upstream-repo'
import type { EndpointKey, ModelPricing, UpstreamRecord } from '@vibe-llm/protocols/common'
import type { MessagesPayload } from '@vibe-llm/protocols/messages'
import {
  probeViaModels,
  resolveExecutionFetcher,
  type ExecutionFetcherForRequest,
  type LlmModelProvider,
  type ProbeResult,
  type ProviderModelsResponse,
  type ProviderRequest,
  type ProviderResponse,
  type InboundHeaderMatcher,
} from '@vibe-llm/provider-llm'

const CLAUDE_CODE_SUPPORTED: readonly EndpointKey[] = ['messages']

// Client headers this provider may see. Mirrors sub2api `gateway_service.go`
// L421-L444 — the set a real Claude Code client sends that Anthropic's billing
// detector reads. Anything outside it is dropped at the gateway boundary, and
// `authorization` is additionally stripped there unconditionally.
//
// Divergence from the reference: it carries `anthropic-beta` as a typed field on
// the call and re-stamps it after filtering, so the raw header is absent from
// its allowlist. vNext has no such typed slot, and detection requires the header
// to be present, so it rides through as an ordinary allowlisted header.
const INBOUND_HEADER_ALLOWLIST: readonly InboundHeaderMatcher[] = [
  'accept',
  /^x-stainless-(?:retry-count|timeout|lang|package-version|os|arch|runtime|runtime-version|helper-method)$/,
  'anthropic-dangerous-direct-browser-access',
  'anthropic-version',
  'anthropic-beta',
  'x-app',
  'accept-language',
  'sec-fetch-mode',
  'user-agent',
  'content-type',
  'accept-encoding',
  'x-claude-code-session-id',
  'x-client-request-id',
]

export class ClaudeCodeProvider implements LlmModelProvider {
  readonly kind = 'claude-code' as const
  readonly name: string
  readonly supportedEndpoints = CLAUDE_CODE_SUPPORTED
  readonly inboundHeaderAllowlist = INBOUND_HEADER_ALLOWLIST
  private readonly upstreamId: string
  private readonly authority: ClaudeCodeExecutionAuthority
  private readonly fetcher: Fetcher
  private readonly executionFetcher?: ExecutionFetcherForRequest
  private catalogCache: ClaudeCodeProviderModel[] | null = null

  constructor(record: UpstreamRecord<unknown>, fetcher: Fetcher = directFetcher, executionFetcher?: ExecutionFetcherForRequest) {
    assertClaudeCodeUpstreamRecord(record)
    assertClaudeCodeUpstreamState(record.state)
    if (!("rowIncarnation" in record) || typeof record.rowIncarnation !== "string" || record.rowIncarnation.trim() === "") {
      throw new TypeError("Claude Code provider requires a stored upstream row incarnation")
    }
    const account = record.state.accounts[0]
    if (!account) throw new TypeError("Claude Code provider requires an account")
    this.authority = Object.freeze({
      upstreamId: record.id, provider: "claude-code", rowIncarnation: record.rowIncarnation, ownerId: record.ownerId,
      accountUuid: account.accountUuid, tokenKind: account.tokenKind,
      credentialGeneration: "credentialGeneration" in record && typeof record.credentialGeneration === "number"
        && Number.isSafeInteger(record.credentialGeneration) && record.credentialGeneration >= 0 ? record.credentialGeneration : undefined,
      configurationGeneration: "catalogGeneration" in record && typeof record.catalogGeneration === "number"
        && Number.isSafeInteger(record.catalogGeneration) && record.catalogGeneration >= 0 ? record.catalogGeneration : undefined,
    })
    this.upstreamId = record.id
    this.name = record.name
    this.fetcher = fetcher
    this.executionFetcher = executionFetcher
  }

  setModelCatalog(models: ProviderModelsResponse): void {
    this.catalogCache = structuredClone(models.data) as ClaudeCodeProviderModel[]
  }

  getModels(): Promise<ProviderModelsResponse> {
    return this.loadCatalog()
  }

  private async loadCatalog(signal = (this.fetcher as Fetcher & { readonly signal?: AbortSignal }).signal): Promise<ProviderModelsResponse> {
    if (!this.catalogCache) {
      signal?.throwIfAborted()
      const access = await ensureClaudeCodeAccessToken({
        upstreamId: this.upstreamId,
        fetcher: this.fetcher,
        expected: this.authority,
        signal,
        beforeMint: async credential => {
          assertClaudeCodeExecutionAuthority(this.authority, credential)
          const current = await readClaudeCodeCredential(this.upstreamId, this.authority, true)
          assertClaudeCodeExecutionAuthority(this.authority, current.credential)
        },
      })
      // A refresh may complete after a configuration edit. Keep its rotated
      // credentials, but do not use the old provider's egress for discovery.
      assertClaudeCodeExecutionAuthority(this.authority, access.credential)
      signal?.throwIfAborted()
      const raw = await fetchClaudeCodeModelsList(access.entry.token, signal
        ? (url, init) => this.fetcher(url, { ...init, signal }) : this.fetcher)
      signal?.throwIfAborted()
      this.catalogCache = buildClaudeCodeCatalog(raw)
    }
    return { object: 'list', data: this.catalogCache }
  }

  probe(): Promise<ProbeResult> {
    return probeViaModels(() => this.getModels())
  }

  getPricingForModelKey(modelKey: string): ModelPricing | null {
    return pricingForClaudeCodeModelKey(modelKey)
  }

  async prepareAffinityExecution(req: Readonly<ProviderRequest>) {
    req.signal?.throwIfAborted()
    if (req.endpoint !== "messages" || !req.payload || typeof req.payload !== "object") return undefined
    const modelId = "model" in req.payload ? req.payload.model : undefined
    const model = this.catalogCache?.find(candidate => candidate.id === modelId)
    if (!model) return undefined
    try {
      const snapshot = await readClaudeCodeCredential(this.upstreamId, this.authority, true)
      req.signal?.throwIfAborted()
      if (snapshot.account.state !== "active") return undefined
      assertClaudeCodeExecutionAuthority(this.authority, snapshot.credential)
      return claudeCodeAffinityTarget(snapshot.credential, model.providerData.upstreamModelId)
    } catch (error) {
      req.signal?.throwIfAborted()
      if (error instanceof UpstreamGoneError || error instanceof UpstreamReplacedError
        || error instanceof ClaudeCodeAffinityChangedError) return undefined
      throw error
    }
  }

  async fetch(req: ProviderRequest): Promise<ProviderResponse> {
    req.signal?.throwIfAborted()
    if (req.endpoint !== 'messages') {
      throw new Error(`ClaudeCodeProvider does not support endpoint: ${req.endpoint}`)
    }
    try {
      // Owned replay cannot discover a catalog or refresh before its first fence.
      if (req.beforeInference) {
        const target = await this.prepareAffinityExecution(req)
        if (!target) throw new ClaudeCodeAffinityChangedError()
        await req.beforeInference(target)
        req.signal?.throwIfAborted()
      }
      const model = await this.resolveModel(req.payload, req.signal)
      req.signal?.throwIfAborted()
      const { model: _ignored, ...wireBody } = req.payload as MessagesPayload

      // Detection runs on the *unmodified* payload — it needs `model` for the
      // Haiku connectivity probe, which `wireBody` has already stripped.
      const shaped = isClaudeCodeShapedRequest({
        headers: req.headers,
        body: req.payload as MessagesPayload,
      })

      let prepared: ClaudeCodePreparedCallResult | undefined
      const terminal = async (): Promise<Response> => {
        prepared = await callClaudeCodeMessagesPrepared({
          upstreamId: this.upstreamId,
          expected: this.authority,
          model,
          // On the shaped path the chain never runs, so this is still the
          // caller's own body verbatim.
          body: bctx.payload,
          signal: req.signal,
          fetcher: this.fetcher,
          executionFetcher: resolveExecutionFetcher(this.fetcher, this.executionFetcher, req),
          shaped,
          inboundHeaders: req.headers,
          beforeInference: req.beforeInference,
        })
        return prepared.response
      }

      // Boundary ctx carries mutable `payload` (interceptors overwrite it
      // in place) plus read-only model + upstreamId (needed by
      // synthesize-metadata-user-id to derive deterministic device/session
      // ids and by backfill for `limits.max_output_tokens`).
      const bctx: MessagesBoundaryCtx = {
        payload: wireBody as MessagesPayload,
        model,
        upstreamId: this.upstreamId,
      }

      // The interceptor chain exists to disguise non-CC traffic as CC. Running
      // it on genuine CC traffic would overwrite the caller's real system
      // blocks, metadata and tool shape with our synthetic equivalents — a
      // fidelity loss for zero benefit. So shaped calls skip straight to the
      // terminal.
      const upstreamResp = shaped
        ? await terminal()
        : await runInterceptors<MessagesBoundaryCtx, object, Response>(
            {},
            bctx,
            CLAUDE_CODE_MESSAGES_BOUNDARY,
            terminal,
          )

      return {
        status: upstreamResp.status,
        headers: upstreamResp.headers,
        body: upstreamResp.body,
        affinityExecution: prepared?.affinityExecution,
        execution: prepared?.execution,
      }
    } catch (err) {
      if (err instanceof ClaudeCodeOAuthSessionTerminatedError || err instanceof ClaudeCodeCredentialUnavailableError) {
        return {
          status: 503,
          headers: new Headers({ 'content-type': 'application/json' }),
          body: new Response(
            JSON.stringify({
              error: {
                type: 'claude_code_upstream_unavailable',
                message: err instanceof ClaudeCodeOAuthSessionTerminatedError
                  ? `Claude Code refresh failed: ${err.upstreamMessage}` : err.message,
              },
            }),
          ).body,
        }
      }
      throw err
    }
  }

  // Gateway sends the canonical payload with `model` as the public alias slug;
  // fetch flow needs the resolved ClaudeCodeProviderModel for the dated
  // upstream id + limits. Cache hit expected — router materializes bindings
  // via getModels before dispatching.
  private async resolveModel(payload: unknown, signal?: AbortSignal): Promise<ClaudeCodeProviderModel> {
    const modelId = (payload as { model?: unknown }).model
    if (typeof modelId !== 'string' || modelId === '') {
      throw new Error('ClaudeCodeProvider.fetch requires payload.model')
    }
    if (!this.catalogCache) await this.loadCatalog(signal)
    const hit = this.catalogCache?.find((m) => m.id === modelId)
    if (!hit) throw new Error(`ClaudeCodeProvider: unknown model '${modelId}'`)
    return hit
  }
}
