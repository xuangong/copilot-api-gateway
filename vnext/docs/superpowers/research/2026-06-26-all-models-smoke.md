# All-model smoke test

Generated: 2026-06-25T18:56:37.012Z

| Endpoint | Model | root :41414 | vNext :41415 |
|---|---|---|---|
| chat | `claude-haiku-4.5` | ✅ | ✅ |
| chat | `claude-opus-4.5` | ✅ | ✅ |
| chat | `claude-opus-4.6` | ✅ | ✅ |
| chat | `claude-opus-4.7` | ✅ | ✅ |
| chat | `claude-opus-4.8` | ✅ | ✅ |
| chat | `claude-sonnet-4.5` | ✅ | ✅ |
| chat | `claude-sonnet-4.6` | ✅ | ✅ |
| chat | `gemini-2.5-pro` | ✅ | ✅ |
| chat | `gemini-3-flash-preview` | ✅ | ✅ |
| chat | `gemini-3.1-pro-preview` | ✅ | ✅ |
| chat | `gemini-3.5-flash` | ✅ | ✅ |
| chat | `gpt-3.5-turbo` | ✅ | ✅ |
| chat | `gpt-3.5-turbo-0613` | ✅ | ✅ |
| chat | `gpt-4` | ✅ | ✅ |
| chat | `gpt-4-0125-preview` | ✅ | ✅ |
| chat | `gpt-4-0613` | ✅ | ✅ |
| chat | `gpt-4-o-preview` | ✅ | ✅ |
| chat | `gpt-4.1` | ✅ | ✅ |
| chat | `gpt-4.1-2025-04-14` | ✅ | ✅ |
| chat | `gpt-41-copilot` | ❌ 500 | ❌ 400 |
| chat | `gpt-4o` | ✅ | ✅ |
| chat | `gpt-4o-2024-05-13` | ✅ | ✅ |
| chat | `gpt-4o-2024-08-06` | ✅ | ✅ |
| chat | `gpt-4o-2024-11-20` | ✅ | ✅ |
| chat | `gpt-4o-mini` | ✅ | ✅ |
| chat | `gpt-4o-mini-2024-07-18` | ✅ | ✅ |
| chat | `gpt-5-mini` | ✅ | ✅ |
| chat | `gpt-5.3-codex` | ✅ | ✅ |
| chat | `gpt-5.4` | ✅ | ✅ |
| chat | `gpt-5.4-mini` | ✅ | ✅ |
| chat | `gpt-5.5` | ✅ | ✅ |
| chat | `mai-code-1-flash-internal` | ❌ 500 | ❌ 400 |
| embed | `text-embedding-3-small` | ✅ | ✅ |
| embed | `text-embedding-3-small-inference` | ✅ | ✅ |
| embed | `text-embedding-ada-002` | ✅ | ✅ |
| chat | `trajectory-compaction` | ✅ | ✅ |

## Failures (snippets)
### `gpt-41-copilot` (chat)
- root `500`: `{"error":"Failed to chat completions: 400 {\"error\":{\"message\":\"Model is not supported for this request.\",\"code\":\"model_not_supported\",\"param\":\"model\",\"type\":\"invalid_request_error\"}}`
- vnext `400`: `{"error":{"type":"invalid_request_error","message":"{\"error\":{\"message\":\"Model is not supported for this request.\",\"code\":\"model_not_supported\",\"param\":\"model\",\"type\":\"invalid_request`

### `mai-code-1-flash-internal` (chat)
- root `500`: `{"error":"Failed to chat completions: 400 {\"error\":{\"message\":\"model \\\"mai-code-1-flash-internal\\\" is not accessible via the /chat/completions endpoint\",\"code\":\"unsupported_api_for_model\`
- vnext `400`: `{"error":{"type":"invalid_request_error","message":"{\"error\":{\"message\":\"model \\\"mai-code-1-flash-internal\\\" is not accessible via the /chat/completions endpoint\",\"code\":\"unsupported_api_`

## Notes

- **34 of 36** models pass on both sides (94%). Failure parity: 2/2 remaining models fail identically on root and vNext, so neither gateway introduces a regression.
- **`gpt-41-copilot`**: Copilot upstream returns `model_not_supported` even when called directly. The model appears in `/v1/models` but is not actually callable via the personal/enterprise plans we test with — likely flighted to specific tenants.
- **`mai-code-1-flash-internal`**: Copilot upstream returns `unsupported_api_for_model` on `/chat/completions`. Same as gpt-5.x reasoning models historically, but the model also lacks a `responses` capability entry — it is an internal-only endpoint not surfaced through our capability map. Out of scope for this gateway.
- **gpt-5.x fix landed in this run**: Previously gpt-5-mini, gpt-5.3-codex, gpt-5.4, gpt-5.4-mini, gpt-5.5 returned 400 on vNext due to `chat_completions` being unconditionally advertised in `copilotModelEndpoints`. After suppressing `chat_completions` for reasoning families (gpt-5*, o1*, o3*, o4*), the pair selector falls back to `responses` and the existing `PAIR_CHAT_TO_RESPONSES` translator handles request/response shape. See `vnext/packages/provider-copilot/src/endpoints.ts`.
