/**
 * True for the model-facing request paths (OpenAI, Anthropic, Responses, Gemini, Ollama, engines aliases) as opposed to
 * dashboard and control-plane routes. Compatibility prefixes are ignored.
 */
export function isInferencePath(requestPath: string): boolean {
  const path = requestPath.replace(/^\/(?:azure-api\.codex|engines\/(?:[^/]+\/)?v1|anthropic)(?=\/)/, '')
  return /^(?:\/v1)?\/(?:messages(?:\/count_tokens)?|chat\/completions|responses(?:\/compact)?|embeddings|images\/(?:generations|edits)|alpha\/search|models|decisions|systemone)$/.test(path)
    || /^\/v1beta\/models(?:\/.*)?$/.test(path) || /^\/api\/(?:chat|generate|embed|embeddings|tags|show)$/.test(path)
}
