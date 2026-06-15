# Plan C3 — Gemini-native /v1beta translators

**Status:** approved 2026-06-15
**Branch:** vNext (no merge to main)

## 1. Problem

`/v1beta/models/<model>:{generateContent,streamGenerateContent,countTokens}`
already routes to `chat-flow/gemini/{http,serve}.ts` via shared dispatch, but
`translator-registry.ts` only registers `gemini→messages`. Real-world bindings
selected by the pair-selector commonly resolve to `chat_completions` (Copilot's
gpt-* gemini-named family) or `responses` (gpt-5/o*), producing 400
`No translator for gemini→<target>`. Additionally, `:countTokens` has no path
at all today.

The reference project (`copilot-gateway`) ships all three translators plus a
dedicated countTokens path. vNext targets full alignment.

## 2. Goals

1. Register `gemini→responses` and `gemini→chat_completions` translator pairs
   so PREFERENCE order in `pair-selector.ts` becomes effective.
2. Make `:countTokens` work end-to-end against the Copilot
   `messages_count_tokens` upstream, returning the Gemini `{ totalTokens }`
   envelope.
3. Mirror `gemini-via-messages` structure (request/events/body + index) so the
   PairTranslator three-tuple stays uniform; do not adopt the reference
   project's TranslateTrip model.
4. Preserve D1 `usage` accounting (stream vs non-stream rows correct).

## 3. Non-goals

- Wiring a gemini-native upstream (no provider declares one today).
- Embeddings via Gemini (`:embedContent`).
- Touching `genericModelEndpoints` heuristics in `providers/registry.ts`.
- Refactoring existing `/v1/messages/count_tokens` handler.

## 4. Architecture

### 4.1 Pair selection (unchanged, already correct)

```ts
PREFERENCE.gemini = ['messages', 'responses', 'chat_completions']
```

Effective only after Tasks 1-3 register the missing pairs.

### 4.2 New translator pairs (mirrors gemini-via-messages)

Two new packages under `packages/translate/src/`:

```
gemini-via-responses/
  request.ts   GeminiPayload → ResponsesPayload
  events.ts   ResponsesStreamEvent → GeminiStreamEvent
  body.ts     ResponsesBody (non-stream JSON) → GeminiBody
  index.ts    re-exports

gemini-via-chat-completions/
  request.ts   GeminiPayload → ChatPayload
  events.ts   ChatStreamEvent → GeminiStreamEvent
  body.ts     ChatBody → GeminiBody
  index.ts    re-exports
```

`request.ts` and `events.ts` are direct ports of the reference project's files
(same shared helpers under `gemini-via/gemini.ts`). `body.ts` is **vNext-new**
because vNext's PairTranslator contract requires non-stream `translateBody`,
which the reference project never needed (it used trip + forceStream).

### 4.3 translator-registry additions

```ts
const PAIR_GEMINI_TO_RESPONSES: PairTranslator = {
  translateRequest: (p, ctx) => translateGeminiToResponses(p as never, {
    model: ctx.model ?? '', fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens,
  }),
  translateEvents: (events, ctx) =>
    translateResponsesToGeminiEvents(events as never, { model: ctx.model ?? '' }),
  translateBody: (body, ctx) =>
    translateResponsesToGeminiBody(body as never, { model: ctx.model ?? '' }),
}

const PAIR_GEMINI_TO_CHAT: PairTranslator = { /* same shape */ }

TABLE['gemini->responses'] = PAIR_GEMINI_TO_RESPONSES
TABLE['gemini->chat_completions'] = PAIR_GEMINI_TO_CHAT
```

`pair-selector.ts` comment about "no translator registered today" is removed.

### 4.4 countTokens (dedicated handler, not dispatch)

```
POST /v1beta/models/<model>:countTokens
  → http.ts detects verb='countTokens'
  → serveGeminiCountTokens (NEW)
      parseGeminiPayload(raw)
      structuredClone + strip:
        - unsupported part fields
        - unsupported tools
        - safetySettings
      translateGeminiToMessages(cleaned, { model, fallbackMaxOutputTokens })
      delete result.stream
      resolveBinding(model, 'messages_count_tokens')
      provider.fetch(endpoint='messages_count_tokens', sourceApi='anthropic')
      reshapeMessagesCountAsGemini(json) → { totalTokens }
      Response.json
```

This intentionally mirrors `chat-flow/count-tokens/serve.ts` (the existing
Anthropic-shaped handler) plus a pre-translate step and a post-reshape step.
Not routed through `dispatch.ts` because:
- verb-on-URL parsing is gemini-specific
- target endpoint is fixed (`messages_count_tokens`), no candidate enumeration
- response shape is JSON-to-JSON reshape, not the dispatch
  translateBody contract

### 4.5 New gateway files

```
chat-flow/gemini/
  count-tokens.ts    serveGeminiCountTokens
  reshape-count.ts    reshapeMessagesCountAsGemini (pure fn, unit-tested)
  http.ts            EXTENDED: branch on verb=':countTokens'
```

## 5. Data flow (generateContent)

```
client → POST /v1beta/models/claude-sonnet-4.6:generateContent {…}
http.ts:
  rawParam='claude-sonnet-4.6:generateContent'
  [model, verb] = split(':')
  if verb === 'countTokens' → serveGeminiCountTokens (§4.4)
  else: forceStream = (verb === 'streamGenerateContent')
        serveGemini → dispatch
            sourceApi='gemini', model='claude-sonnet-4.6'
            enumerate bindings → endpoints → pickTarget=selectPair('gemini',…)
              → first match in PREFERENCE['gemini']
              → claude-* → 'messages'
              → gpt-5/o*  → 'responses'
              → gpt-4o-mini etc → 'chat_completions'
            getTranslator('gemini', target) → PAIR (now always resolves)
            translateRequest → upstream JSON
            stream branch: parseTargetSSE → translateEvents → encodeClientSSE
            non-stream: translateBody → Response.json
```

## 6. body.ts strategy (per-pair)

Both new `body.ts` files re-use `events.ts` accumulators but operate on a
single synthetic event sequence built from the upstream non-stream JSON:

1. Read upstream body (Responses `{ output:[...] }` or Chat `{ choices:[...] }`)
2. Synthesize the equivalent SSE event order:
   - Responses: `response.created` → per-output-item events → `response.completed`
   - Chat: `chat.completion.chunk` (first with role) → delta chunks → final with `finish_reason` + usage
3. Pipe through the same `translate*ToGeminiEvents` accumulator
4. Take the final aggregated `{ candidates, usageMetadata }` frame

This avoids duplicating accumulation logic. Alternative considered: hand-roll a
JSON-to-JSON converter — rejected because tool_calls / parts / usage mapping
already lives in events.ts, and divergence between stream/non-stream would be
a recurring bug magnet.

## 7. Acceptance

### 7.1 Unit tests
- `gemini-via-responses/request_test.ts` — port from reference
- `gemini-via-responses/events_test.ts` — port from reference
- `gemini-via-responses/body_test.ts` — NEW, 3 cases:
  - text completion → `candidates[0].content.parts[0].text`
  - tool_call → `candidates[0].content.parts[i].functionCall`
  - usageMetadata mapping (prompt/candidates/total)
- `gemini-via-chat-completions/{request,events,body}_test.ts` — same shape
- `chat-flow/gemini/reshape-count_test.ts` — `{input_tokens:N}` → `{totalTokens:N}`

### 7.2 Registry coverage
```bash
grep -E "'gemini->(responses|chat_completions)'" \
  packages/gateway/src/data-plane/dispatch/translator-registry.ts
```
Both entries present.

### 7.3 Integration smoke (docker)
```bash
# 1. claude → messages (regression)
curl … :generateContent … model=claude-sonnet-4.6 → 200, candidates non-empty
# 2. gpt-5-mini → responses
curl … :generateContent … model=gpt-5-mini → 200
# 3. gpt-4o-mini → chat_completions (new)
curl … :generateContent … model=gpt-4o-mini-2024-07-18 → 200
# 4. streamGenerateContent for each → SSE frames
# 5. countTokens for each → { totalTokens: N }
```

### 7.4 D1 usage rows
After the smoke set, `data-vnext/vnext.sqlite` `usage` table contains rows for
each model/client=gemini pair with non-zero tokens. `usage_requests` increments.

### 7.5 Existing tests
`bun test` and `bunx tsc --noEmit` continue to pass.

## 8. Risk register

| Risk | Mitigation |
|---|---|
| body.ts diverges from events.ts over time | body.ts internally calls events.ts accumulators, no duplicated mapping logic |
| Reference helpers (`shared/gemini-via/gemini.ts`) absent in vNext | Confirmed already present — used by gemini-via-messages |
| countTokens model has no `messages_count_tokens` upstream | Already-existing 404 path in `count-tokens/serve.ts` reused via shared `resolveBinding` failure shape |
| Registering pairs changes existing claude→messages routing | PREFERENCE order is unchanged; claude still hits messages first |
