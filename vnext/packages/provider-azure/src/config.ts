import { parseEndpoints, normalizeStringRecord, parseOpaqueCompatibilityMap } from "@vibe-llm/provider-llm"
import type { AzureProviderConfig } from "./provider"

/** Surface-qualified execution keys, never public aliases. */
export function parseAzureOpaqueCompatibility(value: unknown) {
  const map = parseOpaqueCompatibilityMap(value)
  if (map) for (const key of Object.keys(map)) {
    const separator = key.indexOf(":")
    const surface = key.slice(0, separator)
    const target = key.slice(separator + 1)
    if ((surface !== "openai" && surface !== "anthropic") || !target || target.trim() !== target) {
      throw new TypeError("Azure opaque compatibility keys must be openai:<deployment> or anthropic:<model>")
    }
  }
  return map
}

function parseAzureDeployments(value: unknown): AzureProviderConfig['deployments'] {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('deployments must be an array of { name, model }')
  const out: Array<{ name: string; model: string }> = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') throw new Error('deployments[] entry must be an object')
    const e = entry as { name?: unknown; model?: unknown }
    if (typeof e.name !== 'string' || !e.name.trim()) throw new Error('deployments[].name required')
    if (typeof e.model !== 'string' || !e.model.trim()) throw new Error('deployments[].model required')
    out.push({ name: e.name.trim(), model: e.model.trim() })
  }
  return out.length > 0 ? out : undefined
}

export function normalizeAzureConfig(config: Record<string, unknown>): AzureProviderConfig {
  if (typeof config.name !== 'string' || !config.name.trim()) throw new Error('azure config.name required')
  if (typeof config.endpoint !== 'string' || !config.endpoint.trim()) throw new Error('azure config.endpoint required')
  if (typeof config.apiKey !== 'string' || !config.apiKey) throw new Error('azure config.apiKey required')
  if (typeof config.deployment !== 'string' || !config.deployment.trim()) {
    throw new Error('azure config.deployment required')
  }
  if (typeof config.apiVersion !== 'string' || !config.apiVersion.trim()) {
    throw new Error('azure config.apiVersion required')
  }
  const defaultHeaders = normalizeStringRecord(config.defaultHeaders, 'defaultHeaders')
  const deployments = parseAzureDeployments(config.deployments)
  return {
    name: config.name.trim(),
    endpoint: config.endpoint.trim().replace(/\/+$/, ''),
    apiKey: config.apiKey,
    deployment: config.deployment.trim(),
    apiVersion: config.apiVersion.trim(),
    endpoints: parseEndpoints(config.endpoints, ['chat_completions']),
    defaultHeaders,
    deployments,
    opaqueCompatibility: parseAzureOpaqueCompatibility(config.opaqueCompatibility),
  }
}
