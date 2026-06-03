/**
 * Orchestrator loop — Week 4b-2 scaffold.
 *
 * Minimal provider-walk: single binding, no 429/5xx fallback yet. Dispatches
 * one upstream call via the given provider and returns the Response verbatim.
 *
 * Follow-ups (tracked separately, NOT in this file):
 *   - Real multi-provider walk with ExecuteResult { retry-next-provider } signal
 *   - Stored responses_items affinity + rewriteStoredResponsesItemsForProvider
 *   - ReAct tool dispatch (server-tool plugin invocation between iterations)
 *   - SSE merge across iterations
 *   - downstreamAbortSignal propagation, iteration cap, timeouts
 *
 * Why scaffold first: the full walk in copilot-gateway/sources/serve.ts is
 * ~600 LOC entangled with persistence and stateful Responses items. Landing
 * that as one commit would mix orchestration design with persistence porting
 * and lose review granularity. This scaffold proves the wiring; each follow-up
 * lands its concern in isolation.
 */
import type { EndpointKey } from '@vnext/protocols/common'
import type { ModelProvider, ProviderFetchOptions } from '../providers/types.ts'

export interface OrchestratorInput {
  provider: ModelProvider
  endpoint: EndpointKey
  init: RequestInit
  opts?: ProviderFetchOptions
}

export interface OrchestratorResult {
  response: Response
  attempts: number
}

export const runOrchestrator = async (input: OrchestratorInput): Promise<OrchestratorResult> => {
  const { provider, endpoint, init, opts } = input
  const response = await provider.fetch(endpoint, init, opts)
  return { response, attempts: 1 }
}
