// Typed wrapper around /v1/models. Uses the playground-selected API key as
// x-api-key, NOT the session cookie — we want the request to look exactly
// like a real client call.

export interface PlaygroundModel {
  id: string
  name?: string
  vendor?: string
  _upstream: string
  _provider: string
  capabilities?: {
    limits?: {
      max_context_window_tokens?: number
      max_prompt_tokens?: number
      max_output_tokens?: number
    }
  }
  [extra: string]: unknown
}

export interface PlaygroundModelsResponse {
  data: PlaygroundModel[]
}

export async function listPlaygroundModels(apiKey: string): Promise<PlaygroundModelsResponse> {
  const resp = await fetch("/v1/models", {
    headers: { "x-api-key": apiKey },
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(text || `HTTP ${resp.status}`)
  }
  const json = (await resp.json()) as PlaygroundModelsResponse
  return json
}
