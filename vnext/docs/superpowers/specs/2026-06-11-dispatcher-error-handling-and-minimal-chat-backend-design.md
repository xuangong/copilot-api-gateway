# Plan 1 Design — Dispatcher Error Handling + Per-Protocol Error Repackage + Minimal Chat Backend

**Date:** 2026-06-11
**Status:** Draft (awaiting user review)
**Sequence:** Plan 1 of 3 (Plan 2: ModelEndpoints refactor; Plan 3: full chat-out + Claude round-trip)

## Goal

Unblock T10 smoke test and make vnext production-serviceable for chat-family models (Claude, gpt-4o-mini, gpt-3.5, etc.) by:

1. Catching `HTTPError` thrown from `provider.fetch()` inside `dispatch()` so upstream non-2xx no longer surfaces as 500 + stdout leak.
2. Repackaging upstream errors into each frontend protocol's native error envelope (messages / chat / responses / gemini).
3. Choosing upstream endpoint per request via model-id heuristics (so chat models stop going to `/responses` and getting `400 unsupported_api_for_model`).
4. Implementing the minimum chat-out / messages-out coverage needed to make the heuristic above actually route somewhere real (input_text / output_text / tool_use / tool_result only).

Plan 2 will replace the heuristic with data-driven `ModelEndpoints` and per-protocol `pickTarget` chains. Plan 3 will replace the minimal chat-out / messages-out with full IRContentItem coverage and Claude-field round-trip. Plan 1 deliberately ships TODO markers at the replacement points.

## Non-Goals

- ModelEndpoints presence map (Plan 2).
- ProviderCandidate[] multi-binding failover (Plan 2).
- Reasoning / thinking / citations / cache_control round-trip (Plan 3).
- input_image, opaque, reasoning IRContentItem variants in chat-out / messages-out (Plan 3).
- Refactoring forward.ts to stop throwing (defer; dispatcher-side catch is sufficient for now).

## Background

Current state after Step 2 commit `5e1c52d`:

- `vnext/apps/gateway/src/data-plane/routes.ts` `dispatch()` (lines 33-90) hardcodes `'responses'` for all four frontend protocols (`/v1/messages`, `/v1/chat/completions`, `/v1/responses`, `/v1beta/models/:model`).
- `responses-out.ts` (87 lines) is implemented and tested end-to-end against gpt-5-mini.
- `chat-out.ts` and `messages-out.ts` are 3-line stubs (throw "not implemented").
- `vnext/packages/provider-copilot/src/forward.ts:95` throws `HTTPError(message, response)` on upstream non-2xx; `dispatch()` has no try/catch, so the throw escapes to Hono and becomes a generic 500 plus stdout of the error message (which embeds upstream response body).
- T10 smoke test outcomes:
  - `/v1/responses` + `gpt-5-mini` ✅
  - `/v1/chat/completions` + `claude-sonnet-4.5` ❌ (upstream 400 unsupported_api_for_model → 500 + leak)
  - `/v1/chat/completions` + `gpt-4o-mini` ❌ (same)
  - `/v1/messages` + `claude-sonnet-4.5` ❌ (same)
  - `GET /v1/models` ✅
  - Token exchange ✅, binding resolution ✅, provider.fetch ✅.

Reference project (`/Users/zhangxian/projects/copilot-gateway`) solves this with data-driven `ModelEndpoints` presence map and per-protocol `pickTarget` chains. Plan 1 is the bridge that keeps the system functional without the full architectural shift — every Plan 1 site that has a TODO will be the integration point Plan 2 modifies.

## Architecture

### Component map

```
+---------------------------+        +-------------------------------+
| frontend adapter (4x)     |  IR    | dispatch() in routes.ts       |
|  - messages-in            |------->|                               |
|  - chat-in                |        |  1. parse → IR                |
|  - responses-in           |        |  2. resolveBinding            |
|  - gemini-in              |        |  3. chooseBackend(IR.model)  ← NEW (heuristic)
+---------------------------+        |  4. backend.toUpstream(IR)    |
                                     |  5. try { provider.fetch }    ← NEW (catch HTTPError)
                                     |     catch (e) → repackage     ← NEW
                                     |  6. backend.decodeSSE/Body    |
                                     |  7. frontend.encodeSSE/Body   |
                                     +-------------------------------+
                                                  |
                                                  v
                             +----------------------------+
                             | backend adapter (3x)       |
                             |  - responses-out (already) |
                             |  - chat-out      ← NEW minimal |
                             |  - messages-out  ← NEW minimal |
                             +----------------------------+
```

### Endpoint selection (Plan 1 heuristic — to be replaced by Plan 2)

A single helper `chooseBackendEndpoint(model: string): EndpointKey` in `vnext/apps/gateway/src/data-plane/routing/backend-selector.ts`:

```ts
// Plan 1 heuristic. TODO(Plan 2): replace with ModelEndpoints + per-protocol pickTarget.
export function chooseBackendEndpoint(model: string): 'responses' | 'chat_completions' | 'messages' {
  const m = model.toLowerCase()
  if (m.startsWith('gpt-5') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) {
    return 'responses'
  }
  if (m.startsWith('claude-')) {
    return 'messages'
  }
  return 'chat_completions'
}
```

Rationale for each family:
- **gpt-5 / o1 / o3 / o4** → upstream Copilot exposes these only on `/responses` (Copilot's reasoning-model surface).
- **claude-*** → upstream Copilot natively serves Anthropic Messages on `/messages`; routing chat-style claude calls through `/chat/completions` works but loses thinking/citations fidelity (Plan 3 handles that round-trip properly).
- **default** → `/chat/completions` (the universal openai-compatible path; ~90% of Copilot's catalog).

This deliberately mirrors the old project's behavior. Documented as a heuristic so Plan 2 has a clear deletion target.

### Backend adapter selection

`dispatch()` calls `chooseBackendEndpoint(ir.model)` and switches the backend adapter accordingly:

```ts
const endpoint = chooseBackendEndpoint(ir.model)
const backend =
  endpoint === 'responses' ? responsesOut :
  endpoint === 'messages'  ? messagesOut :
                              chatOut
const binding = await resolveBinding(requestedModel, endpoint, {...})
```

`resolveBinding` already takes an `EndpointKey`; we just pass the chosen one instead of always `'responses'`. The binding's `upstreamEndpoints: EndpointKey[]` already includes all five Copilot endpoints today, so resolution will succeed for every supported model.

### Error capture and repackaging

```ts
try {
  upstreamRes = await binding.provider.fetch(endpoint, {...})
} catch (err) {
  if (err instanceof HTTPError) {
    return repackageUpstreamError(err.response, sourceApi)
  }
  return repackageUpstreamError(
    new Response(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }),
                 { status: 502, headers: { 'content-type': 'application/json' } }),
    sourceApi,
  )
}
```

`repackageUpstreamError(res: Response, sourceApi: 'messages'|'chat_completions'|'responses'|undefined): Promise<Response>` lives in `vnext/apps/gateway/src/data-plane/errors/repackage.ts` and produces the protocol-native error envelope:

| sourceApi | Body shape |
|-----------|------------|
| `messages` | `{ type: 'error', error: { type, message } }` (Anthropic) |
| `chat_completions` | `{ error: { type, message, code } }` (OpenAI Chat) |
| `responses` | `{ error: { type, message, code } }` (OpenAI Responses — same envelope as Chat) |
| `undefined` (gemini) | `{ error: { code, message, status } }` (Google API style) |

Type mapping:
- 400 → `invalid_request_error`
- 401 / 403 → `authentication_error`
- 404 → `not_found_error`
- 429 → `rate_limit_error`
- 5xx → `api_error`

The function **strips upstream-leaking detail by default** (no header echo, no inner upstream-body echo into the message), but preserves the upstream JSON `error.message` field if the upstream body parses as `{ error: { message: string } }` or `{ message: string }` (so users still see useful info like "model X is not supported for this endpoint"). If parsing fails, message defaults to `"upstream returned ${status}"`.

Status code is preserved verbatim. Content-Type is set to `application/json`.

### Chat-out minimal implementation

`vnext/apps/gateway/src/data-plane/adapters/backend/chat-out.ts` implements `BackendAdapter` with coverage for: `input_text`, `output_text`, `tool_use`, `tool_result` content items, and `function`-type IRToolDef. Other IRContentItem variants (input_image, reasoning, opaque) are SILENTLY DROPPED in Plan 1 (TODO marker for Plan 3).

**`toUpstream(req: IRRequest): unknown`** — emits OpenAI Chat Completions payload:

```ts
{
  model: req.model,
  stream: req.stream,
  messages: [
    // IR system message → { role:'system', content: string }
    // IR user/assistant text → { role, content: string }   (collapsed from input_text/output_text)
    // IR user with tool_result → { role:'tool', tool_call_id, content: stringified output }
    // IR assistant with tool_use → { role:'assistant', content: null|string, tool_calls: [{ id, type:'function', function:{ name, arguments: JSON.stringify(args) }}] }
  ],
  tools: req.tools?.filter(t => t.type === 'function').map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  })),
  tool_choice: req.tool_choice, // pass through if 'auto'|'required'|'none'|{type:'function',name}
  max_tokens: req.max_output_tokens, // note: chat uses max_tokens not max_output_tokens
  temperature: req.temperature,
  top_p: req.top_p,
  parallel_tool_calls: req.parallel_tool_calls,
}
```

Tool_choice shape adjustment: IR's `{type:'function', name}` becomes Chat's `{type:'function', function:{name}}`.

**`decodeSSE(stream): AsyncIterable<IREvent>`** — parses OpenAI Chat SSE (`data: {...}\n\n` frames terminated by `data: [DONE]`):

For each `choices[0].delta`:
- `.content` (string) → `response.output_text.delta { delta }`
- `.tool_calls[i]` with `.id` (first chunk for that index) → `response.output_item.added { item: { type:'tool_use', id, name } }` then accumulate
- `.tool_calls[i].function.arguments` (string chunks) → `response.tool_call.delta { itemId, argumentsDelta }`
- on `choices[0].finish_reason` → emit `response.tool_call.completed` for each open tool_call (parsing accumulated arguments JSON), then `response.completed { response: { finish_reason, usage } }`

First chunk also emits `response.created { response: { id } }` from the chunk's `.id`.

If the JSON parse for accumulated tool_call arguments fails, emit `response.tool_call.completed` with `arguments: { __raw: <accumulated string> }` and let downstream surface it. (Plan 3 will tighten this.)

**`decodeBody(body): AsyncIterable<IREvent>`** — parses non-streaming Chat response (one choice):

Emit synthesized event sequence:
1. `response.created { response: { id: body.id } }`
2. For each tool_call in `choices[0].message.tool_calls`: `response.tool_call.completed { itemId, name, arguments: JSON.parse(arguments_string) }`
3. If `choices[0].message.content` is non-empty string: `response.output_text.delta { delta: content }`
4. `response.completed { response: { id, usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens }, finish_reason: choices[0].finish_reason } }`

### Messages-out minimal implementation

`vnext/apps/gateway/src/data-plane/adapters/backend/messages-out.ts` implements `BackendAdapter` against the Anthropic Messages API for `claude-*` models that route through `/messages` upstream.

Same coverage policy as chat-out: input_text/output_text/tool_use/tool_result only; thinking/citations/cache_control/input_image silently dropped with TODO(Plan 3).

**`toUpstream(req)`**:
```ts
{
  model: req.model,
  stream: req.stream,
  max_tokens: req.max_output_tokens ?? 4096, // Anthropic requires max_tokens
  temperature: req.temperature,
  top_p: req.top_p,
  system: <system message text concatenated>,
  messages: [
    // role: 'user' | 'assistant', content: [{ type:'text', text } | { type:'tool_use', id, name, input } | { type:'tool_result', tool_use_id, content }]
  ],
  tools: req.tools?.filter(t => t.type === 'function').map(t => ({
    name: t.name, description: t.description, input_schema: t.parameters
  })),
  tool_choice: <translated from IR>,
}
```

Note `max_tokens` is REQUIRED by Anthropic Messages API; if IR has no `max_output_tokens`, default to 4096.

**`decodeSSE` / `decodeBody`** — parse Anthropic SSE event types (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`) and emit IR events. For Plan 1, only handle text deltas (`text_delta`) and tool_use blocks (`input_json_delta`). thinking_delta / signature_delta blocks are silently dropped with TODO(Plan 3).

### Files touched

| File | Action | Purpose |
|------|--------|---------|
| `vnext/apps/gateway/src/data-plane/routing/backend-selector.ts` | Create | `chooseBackendEndpoint(model)` heuristic |
| `vnext/apps/gateway/src/data-plane/errors/repackage.ts` | Create | `repackageUpstreamError(res, sourceApi)` |
| `vnext/apps/gateway/src/data-plane/adapters/backend/chat-out.ts` | Rewrite | Minimal Chat Completions backend |
| `vnext/apps/gateway/src/data-plane/adapters/backend/messages-out.ts` | Rewrite | Minimal Anthropic Messages backend |
| `vnext/apps/gateway/src/data-plane/routes.ts` | Modify | Use chooseBackendEndpoint + switch backend; wrap fetch in try/catch with repackage |
| `vnext/apps/gateway/src/data-plane/routing/backend-selector.test.ts` | Create | Heuristic table tests |
| `vnext/apps/gateway/src/data-plane/errors/repackage.test.ts` | Create | Per-protocol envelope tests |
| `vnext/apps/gateway/src/data-plane/adapters/backend/chat-out.test.ts` | Create | toUpstream + decodeSSE + decodeBody happy paths |
| `vnext/apps/gateway/src/data-plane/adapters/backend/messages-out.test.ts` | Create | toUpstream + decodeSSE + decodeBody happy paths |
| `vnext/apps/gateway/src/data-plane/routes.test.ts` | Extend | Cover error 4xx/5xx repackaging across all 4 protocols |

### Test strategy

Unit tests use Bun's `test` runner with vitest-style assertions (already established convention in vnext). For each new module:

- **chooseBackendEndpoint** — table test over model id → expected endpoint.
- **repackageUpstreamError** — for each (status code × sourceApi) cell, assert status preserved, content-type JSON, body matches protocol envelope. Includes a "upstream body had error.message" case.
- **chat-out / messages-out** — happy path for: text-only request, request with one tool definition + tool_choice, streaming response decode, non-streaming response decode, response with tool_call. Use captured upstream wire fixtures (synthesized; we don't need real upstream calls in unit tests).
- **routes.ts** — for each frontend protocol, mock `binding.provider.fetch` to return non-2xx and assert response body matches protocol envelope. Mock it to throw HTTPError and assert same. Add a chat happy-path test that asserts dispatcher chose chat backend for `gpt-4o-mini` (mock provider.fetch records the `endpoint` arg).

T10 smoke test (manual, against real Copilot upstream) re-run after merge to confirm:
- `/v1/chat/completions` + `gpt-4o-mini` returns 200 with valid Chat envelope
- `/v1/messages` + `claude-sonnet-4.5` returns 200 with valid Messages envelope
- `/v1/responses` + `gpt-5-mini` still returns 200 (regression check)
- All four protocols return their native error envelope when given a model that doesn't exist (404)

### Error handling philosophy

- **`HTTPError` from forward.ts** → caught, repackaged, status preserved.
- **Generic `Error` from forward.ts or anywhere in the chain** → caught, repackaged as 502 `api_error` with no upstream detail (we don't trust the message to be safe to surface).
- **`adapter.parse` throw with `.status` and `.body`** → already handled by existing dispatcher (lines 47-50), unchanged.
- **`adapter.toUpstream` throw** → wrapped in 500 api_error (shouldn't happen for the 4 covered IRContentItem variants; if it does, we want it loud).
- **No `console.log` / `console.error` of error detail** — repackager is the only path that touches error text, and it sanitizes.
- **forward.ts `console.log(fullMessage)` at line 93** → out of scope for Plan 1, but flagged: this leaks upstream body to stdout regardless of dispatcher catch. Plan 2 should remove it or replace with structured logger.

## Open Questions

None — all four brainstorming questions answered:
1. Backend selection: heuristic now (Plan 1), data-driven `ModelEndpoints` later (Plan 2).
2. chat-out scope: 4 core IRContentItem variants for Plan 1, full coverage Plan 3.
3. Claude fields: silently dropped for Plan 1, full round-trip Plan 3.
4. Error format: protocol-native repackaging.

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Heuristic misclassifies a new model family (e.g. future `gpt-6`) | Default `chat_completions` is the safest fallback; surfaces as upstream 400 if wrong, which now produces a clean error envelope instead of 500. Plan 2 fixes via data. |
| Tool_call arguments JSON parse fails mid-stream | Emit `__raw` accumulator field rather than throwing; client sees malformed but non-fatal result. Plan 3 will tighten. |
| Anthropic Messages requires `max_tokens` but IR has none | Default 4096; acceptable per Anthropic SDK conventions. |
| messages-out drops thinking blocks → user-visible regression on Claude models | Plan 3 explicitly addresses; flag as known limitation in commit message. |
| forward.ts still `console.log`s upstream body | Out of scope but documented. Repackaged Response body is sanitized, so the *client* doesn't see the leak — only worker logs do. Acceptable for Plan 1; Plan 2 cleans up. |

## Acceptance Criteria

- [ ] All vnext unit tests pass (`bun test` in repo root).
- [ ] New unit tests for backend-selector / repackage / chat-out / messages-out / routes error paths all pass.
- [ ] Manual T10 re-run: all 5 smoke cases (gpt-5-mini responses, gpt-4o-mini chat, claude messages, model-not-found, stream chat) return correct status + protocol envelope.
- [ ] `bun run typecheck` (or workspace equivalent) is clean.
- [ ] No new `console.log` / `console.error` calls in dispatcher or adapters.
- [ ] Commit message names this as Plan 1 of 3 and links the spec.
