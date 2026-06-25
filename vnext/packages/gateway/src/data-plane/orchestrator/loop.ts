/**
 * Orchestrator loop — Week 4b-2 scaffold.
 *
 * Minimal provider-walk: single binding, no 429/5xx fallback yet. Dispatches
 * one upstream call via the given provider and returns the Response verbatim.
 *
 * Follow-ups (tracked separately, NOT in this file):
 *   - Real multi-provider walk with LlmExecuteResult { retry-next-provider } signal
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
import type { LlmModelProvider, ProviderRequest } from '@vibe-llm/provider-llm'

export interface OrchestratorInput {
  provider: LlmModelProvider
  req: ProviderRequest
}

export interface OrchestratorResult {
  response: Response
  attempts: number
}

export const runOrchestrator = async (input: OrchestratorInput): Promise<OrchestratorResult> => {
  const pr = await input.provider.fetch(input.req)
  return { response: new Response(pr.body, { status: pr.status, headers: pr.headers }), attempts: 1 }
}
