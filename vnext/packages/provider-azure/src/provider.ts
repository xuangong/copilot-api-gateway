/**
 * Azure OpenAI / Azure-hosted Anthropic provider. Verbatim port of
 * src/providers/azure/provider.ts from main; uses @vnext/shared-http
 * helpers in place of the inline transport utilities.
 *
 * Each Azure upstream is a set of named deployments. The deployment name is
 * embedded in the URL path (`/openai/deployments/<name>/<op>?api-version=…`)
 * for OpenAI-shape endpoints, or under `/anthropic/v1/<op>` for Azure-hosted
 * Anthropic Messages.
 *
 * Authentication uses the `api-key` header (Azure convention), not bearer.
 */

import type { EndpointKey } from '@vnext/protocols/common'
import type {
  ModelProvider,
  ProbeResult,
  ProviderFetchOptions,
  ProviderModelsResponse,
} from '@vnext/provider'

export interface AzureProviderConfig {
  name: string
  endpoint: string
  apiKey: string
  deployment: string
  apiVersion: string
  endpoints: readonly EndpointKey[]
  defaultHeaders?: Record<string, string>
  deployments?: ReadonlyArray<{ name: string; model: string }>
}

export class AzureProvider implements ModelProvider {
  readonly kind = 'azure' as const
  readonly name: string
  readonly supportedEndpoints: readonly EndpointKey[]
  private readonly endpoint: string
  private readonly apiKey: string
  private readonly deployment: string
  private readonly apiVersion: string
  private readonly defaultHeaders: Record<string, string>
  private readonly extraDeployments: ReadonlyArray<{ name: string; model: string }>

  constructor(cfg: AzureProviderConfig) {
    if (!cfg.apiKey) throw new Error('Azure provider requires an apiKey')
    if (!cfg.endpoint) throw new Error('Azure provider requires an endpoint')
    if (!cfg.deployment) throw new Error('Azure provider requires a deployment')
    if (!cfg.apiVersion) throw new Error('Azure provider requires an apiVersion')
    this.name = cfg.name
    this.endpoint = cfg.endpoint.replace(/\/+$/, '')
    this.apiKey = cfg.apiKey
    this.deployment = cfg.deployment
    this.apiVersion = cfg.apiVersion
    this.supportedEndpoints = cfg.endpoints
    this.defaultHeaders = cfg.defaultHeaders ?? {}
    this.extraDeployments = cfg.deployments ?? []
  }

  async getModels(): Promise<ProviderModelsResponse> {
    throw new Error('not yet implemented')
  }

  async probe(): Promise<ProbeResult> {
    throw new Error('not yet implemented')
  }

  async fetch(_endpoint: EndpointKey, _init: RequestInit, _opts: ProviderFetchOptions = {}): Promise<Response> {
    throw new Error('not yet implemented')
  }
}
