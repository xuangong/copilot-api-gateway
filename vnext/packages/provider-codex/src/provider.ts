/**
 * CodexProvider — LlmModelProvider implementation over the codex ChatGPT
 * responses backend.
 *
 * Ported from copilot-gateway/packages/provider-codex/src/provider.ts, with
 * vNext adaptations:
 *   - `createCodexProvider(record) → Provider` factory replaced by a class
 *     that implements the vNext `LlmModelProvider` contract.
 *   - Reference project's per-endpoint methods (`callResponses(model, body,
 *     action, ...)`) collapse into a single `fetch(req: ProviderRequest)`.
 *     The `action` verb ('generate' | 'compact') travels on ProviderRequest,
 *     dispatched internally to `callCodexResponses` /
 *     `callCodexResponsesCompact`.
 *   - Boundary interceptor chain is empty in F3b — codex responses
 *     interceptors land in F5. The dispatch is inlined; runInterceptors is
 *     not invoked.
 *   - Access-token / quota / models / catalog logic is unchanged in shape.
 *   - Credential effects capture row identity, revision and the used token.
 */
import { codexAffinityTarget } from "./affinity-execution"
import { ensureCodexAccessToken, mintCodexAccessToken, rejectCodexAccessToken } from './access-token'
import { assertCodexUpstreamRecord, type CodexUpstreamConfig } from './config'
import {
  callCodexAlphaSearch,
  callCodexResponsesPrepared,
  callCodexResponsesCompactPrepared,
  type CodexPreparedCallResult,
} from './fetch'
import { directFetcher, type Fetcher } from './fetcher'
import { codexResponsesBoundary } from './interceptors/responses'
import {
  CodexCatalogAuthError,
  codexRawToProviderModel,
  fetchCodexCatalog,
  type CodexProviderModel,
} from './models'
import { pricingForCodexModelKey } from './pricing'
import { assertCodexUpstreamState } from './state'
import { runInterceptors } from '@vibe-core/service'
import { codexBearerEffect, persistCodexTerminalState, readCodexCredential } from "./credential-effects"
import type { UpstreamWriteTarget } from "@vibe-core/upstream-repo"
import type {
  EndpointKey,
  Invocation,
  ModelPricing,
  RequestContext,
  UpstreamRecord,
} from '@vibe-llm/protocols/common'
import {
  probeViaModels,
  resolveExecutionFetcher,
  type ExecutionFetcherForRequest,
  type LlmModelProvider,
  type ProbeResult,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderModelsResponse,
  type SourceApi,
} from '@vibe-llm/provider-llm'

const CODEX_SUPPORTED: readonly EndpointKey[] = ['responses', 'alpha_search']

export class CodexProvider implements LlmModelProvider {
  readonly kind = 'codex' as const
  readonly name: string
  readonly supportedEndpoints = CODEX_SUPPORTED
  private readonly upstreamId: string
  private readonly writeTarget: UpstreamWriteTarget
  private readonly configurationGeneration?: number
  private readonly config: CodexUpstreamConfig
  private readonly fetcher: Fetcher
  private readonly executionFetcher?: ExecutionFetcherForRequest
  private catalogCache: CodexProviderModel[] | null = null

  constructor(record: UpstreamRecord<unknown>, fetcher: Fetcher = directFetcher, executionFetcher?: ExecutionFetcherForRequest) {
    assertCodexUpstreamRecord(record)
    assertCodexUpstreamState(record.state)
    // The plugin receives the already-authorized stored row. Looking up an
    // incarnation by ID later could adopt another owner's replacement row.
    if (!("rowIncarnation" in record) || typeof record.rowIncarnation !== "string" || record.rowIncarnation.trim() === "") {
      throw new TypeError("Codex provider requires a stored upstream row incarnation")
    }
    this.upstreamId = record.id
    this.writeTarget = {
      rowIncarnation: record.rowIncarnation, ownerId: record.ownerId, provider: record.provider,
    }
    this.configurationGeneration = "catalogGeneration" in record && typeof record.catalogGeneration === "number"
      && Number.isSafeInteger(record.catalogGeneration) && record.catalogGeneration >= 0 ? record.catalogGeneration : undefined
    this.config = structuredClone(record.config)
    this.name = record.name
    this.fetcher = fetcher
    this.executionFetcher = executionFetcher
  }

  setModelCatalog(models: ProviderModelsResponse): void {
    this.catalogCache = structuredClone(models.data) as CodexProviderModel[]
  }

  async getModels(): Promise<ProviderModelsResponse> {
    if (!this.catalogCache) {
      const accountId = this.config.accounts[0].chatgptAccountId
      const discoverySignal = (this.fetcher as Fetcher & { readonly signal?: AbortSignal }).signal
      const access = await ensureCodexAccessToken(this.upstreamId, accountId, (refresh, signal) =>
        mintCodexAccessToken(refresh, this.fetcher, signal),
        false,
        this.writeTarget,
        discoverySignal,
        this.fetcher,
      )
      let raw: Awaited<ReturnType<typeof fetchCodexCatalog>>
      try {
        raw = await fetchCodexCatalog({
          accessToken: access.token,
          accountId,
          fetcher: this.fetcher,
          signal: discoverySignal,
        })
        if (discoverySignal?.aborted) throw new DOMException('Codex catalog request aborted', 'AbortError')
      } catch (error) {
        if (discoverySignal?.aborted) throw new DOMException('Codex catalog request aborted', 'AbortError')
        if (error instanceof CodexCatalogAuthError) {
          if (error.code === 'token_invalidated') {
            await persistCodexTerminalState(codexBearerEffect(access), 'session_terminated', 'token_invalidated')
            throw new Error('Codex catalog session_terminated')
          }
          if (!access.renewable) {
            await rejectCodexAccessToken(access)
            throw new Error('Codex catalog access_rejected')
          }
        }
        throw error
      }
      this.catalogCache = raw.map(codexRawToProviderModel)
    }
    return { object: 'list', data: this.catalogCache }
  }

  probe(): Promise<ProbeResult> {
    return probeViaModels(() => this.getModels())
  }

  getPricingForModelKey(modelKey: string): ModelPricing | null {
    return pricingForCodexModelKey(modelKey)
  }

  async prepareAffinityExecution(req: Readonly<ProviderRequest>) {
    req.signal?.throwIfAborted()
    if (req.endpoint !== "responses" || !req.payload || typeof req.payload !== "object") return undefined
    const modelId = "model" in req.payload ? req.payload.model : undefined
    // Catalog misses must remain misses: selection cannot refresh OAuth/models.
    const model = this.catalogCache?.find(candidate => candidate.id === modelId)
    if (!model) return undefined
    const { credential, account } = await readCodexCredential(this.upstreamId, this.config.accounts[0].chatgptAccountId, this.writeTarget)
    req.signal?.throwIfAborted()
    if (account.state !== "active") return undefined
    if (credential.configurationGeneration !== this.configurationGeneration) return undefined
    return codexAffinityTarget(credential, model.id)
  }

  async fetch(req: ProviderRequest): Promise<ProviderResponse> {
    if (req.endpoint === 'alpha_search') {
      return await this.callAlphaSearch(req)
    }
    if (req.endpoint !== 'responses') {
      throw new Error(`CodexProvider does not support endpoint: ${req.endpoint}`)
    }
    const model = await this.resolveModel(req.payload)

    // Boundary chain: strip unsupported fields + inject default instructions.
    // Interceptors mutate `inv.payload` in place; the terminal reads the
    // mutated payload before dispatching to the wire.
    const headerRecord: Record<string, string> = {}
    req.headers.forEach((v, k) => {
      headerRecord[k] = v
    })
    const inv: Invocation = {
      endpoint: 'responses',
      enabledFlags: new Set<string>(),
      sourceApi: mapSourceApi(req.sourceApi),
      action: req.action,
      payload: { ...(req.payload as Record<string, unknown>), model: model.id } as Record<
        string,
        unknown
      >,
      headers: headerRecord,
    }
    const ctx: RequestContext = {
      requestStartedAt: Date.now(),
      downstreamAbortSignal: req.signal,
    }

    let preparedResult: CodexPreparedCallResult | undefined
    const upstreamResp = await runInterceptors(inv, ctx, codexResponsesBoundary, async () => {
      const { account, credential } = await readCodexCredential(this.upstreamId, this.config.accounts[0].chatgptAccountId, this.writeTarget)
      const { model: _ignored, ...wireBody } = inv.payload as Record<string, unknown>
      const backendCallBase = {
        upstreamId: this.upstreamId,
        account,
        credential,
        model,
        headers: new Headers(inv.headers),
        signal: req.signal,
        fetcher: this.fetcher,
        executionFetcher: resolveExecutionFetcher(this.fetcher, this.executionFetcher, req),
        beforeInference: req.beforeInference,
      }
      preparedResult = inv.action === 'compact'
        ? await callCodexResponsesCompactPrepared({ ...backendCallBase, body: wireBody })
        : await callCodexResponsesPrepared({ ...backendCallBase, body: wireBody })
      return preparedResult.response
    })

    return {
      status: upstreamResp.status,
      headers: upstreamResp.headers,
      body: upstreamResp.body,
      affinityExecution: preparedResult?.affinityExecution,
      execution: preparedResult?.execution,
      responsesAdapter: preparedResult?.responsesAdapter,
      compactAdapter: preparedResult?.compactAdapter,
    }
  }

  // Codex fetch flow needs the resolved CodexProviderModel for id + limits.
  // The gateway sends the canonical payload with `model` as the slug string,
  // so we look it up in the catalog. Cache hit expected on the hot path
  // (getModels was called by the router when materializing bindings).
  private async resolveModel(payload: unknown): Promise<CodexProviderModel> {
    const modelId = (payload as { model?: unknown }).model
    if (typeof modelId !== 'string' || modelId === '') {
      throw new Error('CodexProvider.fetch requires payload.model')
    }
    if (!this.catalogCache) await this.getModels()
    const hit = this.catalogCache?.find((m) => m.id === modelId)
    if (!hit) throw new Error(`CodexProvider: unknown model '${modelId}'`)
    return structuredClone(hit)
  }

  // Alpha search skips interceptors — the codex CLI SearchRequest shape is
  // passed through opaquely; the fetch layer injects the account model + id.
  private async callAlphaSearch(req: ProviderRequest): Promise<ProviderResponse> {
    const model = await this.resolveModel(req.payload)
    const { account, credential } = await readCodexCredential(this.upstreamId, this.config.accounts[0].chatgptAccountId, this.writeTarget)
    const { model: _ignored, ...body } = req.payload as Record<string, unknown>
    const upstreamResp = await callCodexAlphaSearch({
      upstreamId: this.upstreamId,
      account,
      credential,
      model,
      headers: new Headers(req.headers),
      signal: req.signal,
      fetcher: this.fetcher,
      executionFetcher: resolveExecutionFetcher(this.fetcher, this.executionFetcher, req),
      body,
    })
    return {
      status: upstreamResp.status,
      headers: upstreamResp.headers,
      body: upstreamResp.body,
    }
  }
}

function mapSourceApi(src: SourceApi): 'messages' | 'chat_completions' | 'responses' | 'gemini' {
  if (src === 'anthropic') return 'messages'
  if (src === 'openai') return 'chat_completions'
  return src
}
