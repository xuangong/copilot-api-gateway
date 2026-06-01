# Plan 3: messages + messages_count_tokens Caller Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate every `provider.callMessages(payload, opts)` and `provider.callMessagesCountTokens(payload, opts)` callsite to `provider.fetch("messages", ...)` / `provider.fetch("messages_count_tokens", ...)`, then delete both wrappers from the `ModelProvider` interface and all three provider implementations.

**Architecture:** Paired migration because both endpoints share Copilot's variant-and-beta filtering pipeline (`applyVariantAndBetaFiltering` called inside `fetch()` for both `messages` and `messages_count_tokens` per Plan 0's `VARIANT_KIND` table). Migrating them together avoids partial states where one endpoint sees post-Plan-3 mock shapes while the other still has the wrapper.

**Tech Stack:** Bun runtime + TypeScript. 10 production callsites total (8 for messages, 2 for count_tokens) across `src/routes/{messages,responses,chat-completions-messages-fallback,gemini-messages-fallback,gemini,messages/index}.ts` and `src/services/web-search/interceptor.ts`. Test files: `tests/{provider-binding,gemini-stream-usage,responses-stream-usage,copilot-provider-variant,azure-provider}.test.ts`.

---

## File Structure

**Caller files modified — messages (production code, 5 files, 8 callsites):**
- `src/routes/messages/direct.ts:44` and `:93` — main /v1/messages route, stream + non-stream
- `src/routes/chat-completions-messages-fallback.ts:60` and `:112` — chat-completions → messages fallback (stream + non-stream)
- `src/routes/gemini-messages-fallback.ts:69` and `:117` — gemini → messages fallback (stream + non-stream)
- `src/routes/responses/messages-fallback.ts:49` and `:86` — responses → messages fallback (stream + non-stream)
- `src/services/web-search/interceptor.ts:69` and `:81` — web-search interceptor (non-stream + stream)

**Caller files modified — count_tokens (production code, 2 files, 2 callsites):**
- `src/routes/messages/index.ts:90` — /v1/messages/count_tokens route
- `src/routes/gemini.ts:235` — Gemini countTokens adapter

**Test files modified (5 files):**
- `tests/provider-binding.test.ts` — delete `callMessages` + `callMessagesCountTokens` entries from inline mock
- `tests/gemini-stream-usage.test.ts:20` — fold `callMessages` stub into the `fetch` shim
- `tests/responses-stream-usage.test.ts:20` — same
- `tests/copilot-provider-variant.test.ts:83, 117, 133` — migrate 3 direct calls to `fetch("messages", ...)`
- `tests/azure-provider.test.ts:75, 88` — migrate 2 direct calls (one happy-path, one error-path)

**Files modified (interface + implementations, 4 files):**
- `src/providers/types.ts:41-42` — delete both wrapper lines
- `src/providers/copilot/provider.ts:52, 56` — delete both wrapper methods
- `src/providers/custom/provider.ts:120, 124` — delete both wrapper methods
- `src/providers/azure/provider.ts:129, 132` — delete both wrapper methods

**Untouched (intentionally):**
- Production callsites for `callEmbeddings` — Plan 4.
- Test mocks for `callEmbeddings` stay until Plan 4.

---

## Migration Recipe

**For messages:**

```ts
// Before
const response = await provider.callMessages(
  payload as unknown as Record<string, unknown>,
  { operationName: "create message", extraHeaders: passthroughHeaders },
)

// After
const response = await provider.fetch(
  "messages",
  { method: "POST", body: JSON.stringify(payload) },
  { operationName: "create message", extraHeaders: passthroughHeaders },
)
```

**For count_tokens:**

```ts
// Before
const response = await binding.provider.callMessagesCountTokens(
  payload as unknown as Record<string, unknown>,
  { operationName: "count tokens", extraHeaders: ... },
)

// After
const response = await binding.provider.fetch(
  "messages_count_tokens",
  { method: "POST", body: JSON.stringify(payload) },
  { operationName: "count tokens", extraHeaders: ... },
)
```

For `withConnectionMismatchRetry((p) => provider.callMessages(p, opts))` sites, the inner lambda becomes `(p) => provider.fetch("messages", { method: "POST", body: JSON.stringify(p) }, opts)`. Retry helper signature unchanged.

**Important:** `messages_count_tokens` does NOT require `model` in payload. Plan 0's Copilot `fetch()` already special-cases this via `requireModel = opts.requireModel ?? (endpoint !== "messages_count_tokens")` — no explicit `requireModel: false` opt needed at callsites.

---

## Task 1: Migrate src/routes/messages/direct.ts

**Files:**
- Modify: `src/routes/messages/direct.ts:44-47` and `:93-96`

- [ ] **Step 1: Read lines 40-100 for context**

Run: `sed -n '40,100p' src/routes/messages/direct.ts`
Confirm both callsites pass `payload as unknown as Record<string, unknown>` plus a `{ operationName, extraHeaders }` opts.

- [ ] **Step 2: Apply transform to line 44 (stream branch)**

Replace:

```ts
    const response = await provider.callMessages(
      payload as unknown as Record<string, unknown>,
      { operationName: "create message", extraHeaders: passthroughHeaders },
    )
```

with:

```ts
    const response = await provider.fetch(
      "messages",
      { method: "POST", body: JSON.stringify(payload) },
      { operationName: "create message", extraHeaders: passthroughHeaders },
    )
```

- [ ] **Step 3: Apply identical transform to line 93 (non-stream branch)**

Same replacement; preserve `passthroughHeaders` variable name verbatim.

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/routes/messages/direct.ts
git commit -m "refactor(messages): dispatch via provider.fetch('messages', ...)"
```

---

## Task 2: Migrate src/routes/chat-completions-messages-fallback.ts

**Files:**
- Modify: `src/routes/chat-completions-messages-fallback.ts:60` and `:112`

- [ ] **Step 1: Read lines 55-120 for context**

Run: `sed -n '55,120p' src/routes/chat-completions-messages-fallback.ts`
Confirm both callsites use `withConnectionMismatchRetry((p) => provider.callMessages(p, opts))`.

- [ ] **Step 2: Apply transform to both callsites**

For each, replace:

```ts
        provider.callMessages(p as Record<string, unknown>, {
          operationName: <literal>,
        }),
```

with:

```ts
        provider.fetch(
          "messages",
          { method: "POST", body: JSON.stringify(p) },
          { operationName: <literal> },
        ),
```

Preserve `<literal>` verbatim (likely `"chat completions (via messages)"` or similar — copy from file, do not invent).

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/routes/chat-completions-messages-fallback.ts
git commit -m "refactor(cc-messages-fallback): dispatch messages via provider.fetch()"
```

---

## Task 3: Migrate src/routes/gemini-messages-fallback.ts

**Files:**
- Modify: `src/routes/gemini-messages-fallback.ts:69` and `:117`

- [ ] **Step 1: Read lines 60-125 for context**

Run: `sed -n '60,125p' src/routes/gemini-messages-fallback.ts`

- [ ] **Step 2: Apply transform to both callsites**

Same recipe as Task 2 — `provider.callMessages(p, { operationName: <literal> })` → `provider.fetch("messages", { method: "POST", body: JSON.stringify(p) }, { operationName: <literal> })`.

- [ ] **Step 3: Run gemini stream-usage test**

Run: `bun test tests/gemini-stream-usage.test.ts`
Expected: PASS today (mock still has `callMessages` — Task 6 fixes it).

- [ ] **Step 4: Commit**

```bash
git add src/routes/gemini-messages-fallback.ts
git commit -m "refactor(gemini-messages-fallback): dispatch via provider.fetch('messages', ...)"
```

---

## Task 4: Migrate src/routes/responses/messages-fallback.ts

**Files:**
- Modify: `src/routes/responses/messages-fallback.ts:49` and `:86`

- [ ] **Step 1: Apply transform to line 49**

Replace:

```ts
      (p) => provider.callMessages(p as Record<string, unknown>, { operationName: "responses (via messages)" }),
```

with:

```ts
      (p) => provider.fetch(
        "messages",
        { method: "POST", body: JSON.stringify(p) },
        { operationName: "responses (via messages)" },
      ),
```

- [ ] **Step 2: Apply identical transform to line 86**

Same replacement.

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/routes/responses/messages-fallback.ts
git commit -m "refactor(responses-messages-fallback): dispatch via provider.fetch('messages', ...)"
```

---

## Task 5: Migrate src/services/web-search/interceptor.ts

**Files:**
- Modify: `src/services/web-search/interceptor.ts:69-72` and `:81-84`

- [ ] **Step 1: Apply transform to non-stream call (line 69)**

Replace:

```ts
  const response = await createCopilotProvider({ copilotToken: options.copilotToken, accountType: options.accountType }).callMessages(
    payload as unknown as Record<string, unknown>,
    { operationName: "create message" },
  )
```

with:

```ts
  const response = await createCopilotProvider({
    copilotToken: options.copilotToken,
    accountType: options.accountType,
  }).fetch(
    "messages",
    { method: "POST", body: JSON.stringify(payload) },
    { operationName: "create message" },
  )
```

- [ ] **Step 2: Apply transform to stream call (line 81)**

Replace:

```ts
  const response = await createCopilotProvider({ copilotToken: options.copilotToken, accountType: options.accountType }).callMessages(
    { ...payload, stream: true } as unknown as Record<string, unknown>,
    { operationName: "create message stream" },
  )
```

with:

```ts
  const response = await createCopilotProvider({
    copilotToken: options.copilotToken,
    accountType: options.accountType,
  }).fetch(
    "messages",
    { method: "POST", body: JSON.stringify({ ...payload, stream: true }) },
    { operationName: "create message stream" },
  )
```

- [ ] **Step 3: Run interceptor tests**

Run: `bun test tests/interceptor.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/services/web-search/interceptor.ts
git commit -m "refactor(web-search): dispatch messages via provider.fetch('messages', ...)"
```

---

## Task 6: Update stream-usage test mocks for messages

**Files:**
- Modify: `tests/gemini-stream-usage.test.ts:17-32`
- Modify: `tests/responses-stream-usage.test.ts:17-32`

After Plan 2, each mock looks roughly like:

```ts
mock.module("~/providers/registry", () => ({
  createCopilotProvider: () => ({
    supportedEndpoints: ["chat_completions", "responses"],
    fetch: async (endpoint: string) => {
      if (!upstreamResponse) throw new Error("missing upstream response")
      if (endpoint !== "chat_completions" && endpoint !== "responses") {
        throw new Error(`unexpected endpoint: ${endpoint}`)
      }
      return upstreamResponse
    },
    callMessages: async () => {
      if (!upstreamResponse) throw new Error("missing upstream response")
      return upstreamResponse
    },
  }),
}))
```

- [ ] **Step 1: Read both files to see current shape**

Run: `sed -n '15,35p' tests/gemini-stream-usage.test.ts tests/responses-stream-usage.test.ts`

- [ ] **Step 2: For each file, add `"messages"` to `supportedEndpoints` + allowed endpoints in the `fetch` shim, and remove the `callMessages` block**

Replace the mock with:

```ts
mock.module("~/providers/registry", () => ({
  createCopilotProvider: () => ({
    supportedEndpoints: ["chat_completions", "responses", "messages"],
    fetch: async (endpoint: string) => {
      if (!upstreamResponse) throw new Error("missing upstream response")
      if (
        endpoint !== "chat_completions" &&
        endpoint !== "responses" &&
        endpoint !== "messages"
      ) {
        throw new Error(`unexpected endpoint: ${endpoint}`)
      }
      return upstreamResponse
    },
  }),
}))
```

Drop any keys (`callChatCompletions`, `callResponses`, `callMessages`) that are no longer needed after Plans 1 + 2 + this task.

- [ ] **Step 3: Run both tests**

Run: `bun test tests/gemini-stream-usage.test.ts tests/responses-stream-usage.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/gemini-stream-usage.test.ts tests/responses-stream-usage.test.ts
git commit -m "test(stream-usage): swap callMessages mocks to fetch() surface"
```

---

## Task 7: Migrate tests/copilot-provider-variant.test.ts direct calls

**Files:**
- Modify: `tests/copilot-provider-variant.test.ts:83, 117, 133`

There are 3 direct `provider().callMessages(...)` invocations. Each must move to `provider().fetch("messages", { method: "POST", body: JSON.stringify(...) }, [opts])`.

- [ ] **Step 1: Read lines 75-150 to see all 3 callsites and their payload shapes**

Run: `sed -n '75,150p' tests/copilot-provider-variant.test.ts`

- [ ] **Step 2: Migrate line 83 call**

Replace:

```ts
    await provider().callMessages({
      ...payload literal...
    })
```

with:

```ts
    await provider().fetch(
      "messages",
      { method: "POST", body: JSON.stringify({
        ...payload literal...
      }) },
    )
```

Preserve the payload literal verbatim.

- [ ] **Step 3: Migrate line 117 call**

The call at line 117 likely takes a second opts argument (`{ extraHeaders: ... }`). Replace:

```ts
    await provider().callMessages(
      { ...payload literal... },
      { extraHeaders: ... },
    )
```

with:

```ts
    await provider().fetch(
      "messages",
      { method: "POST", body: JSON.stringify({ ...payload literal... }) },
      { extraHeaders: ... },
    )
```

Preserve both literals verbatim.

- [ ] **Step 4: Migrate line 133 call**

Same recipe as Step 3.

- [ ] **Step 5: Run variant test**

Run: `bun test tests/copilot-provider-variant.test.ts`
Expected: PASS — variant filtering still triggers because `fetch("messages", ...)` calls `applyVariantAndBetaFiltering` (Plan 0 wiring).

- [ ] **Step 6: Commit**

```bash
git add tests/copilot-provider-variant.test.ts
git commit -m "test(copilot-variant): migrate messages assertions to fetch() surface"
```

---

## Task 8: Migrate tests/azure-provider.test.ts direct calls

**Files:**
- Modify: `tests/azure-provider.test.ts:75` and `:88`

- [ ] **Step 1: Read lines 70-95 for both callsites**

Run: `sed -n '70,95p' tests/azure-provider.test.ts`

- [ ] **Step 2: Migrate line 75 (happy-path)**

Replace:

```ts
    await p.callMessages({ messages: [] })
```

with:

```ts
    await p.fetch(
      "messages",
      { method: "POST", body: JSON.stringify({ messages: [] }) },
    )
```

- [ ] **Step 3: Migrate line 88 (error-path expecting "does not serve endpoint")**

Replace:

```ts
    await expect(p.callMessages({ messages: [] })).rejects.toThrow(/does not serve endpoint/)
```

with:

```ts
    await expect(
      p.fetch("messages", { method: "POST", body: JSON.stringify({ messages: [] }) }),
    ).rejects.toThrow(/does not serve endpoint/)
```

The error message comes from Plan 0's Azure `fetch()`:

```ts
if (!this.supportedEndpoints.includes(endpoint)) {
  throw new Error(`Azure deployment ${this.name} does not serve endpoint: ${endpoint}`)
}
```

The regex still matches.

- [ ] **Step 4: Run azure-provider test**

Run: `bun test tests/azure-provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/azure-provider.test.ts
git commit -m "test(azure): migrate messages assertions to fetch() surface"
```

---

## Task 9: Migrate src/routes/messages/index.ts (count_tokens)

**Files:**
- Modify: `src/routes/messages/index.ts:90-95`

- [ ] **Step 1: Apply transform**

Replace:

```ts
    const response = await binding.provider.callMessagesCountTokens(
      payload as unknown as Record<string, unknown>,
      {
        operationName: "count tokens",
        extraHeaders: extractAnthropicPassthroughHeaders(ctx),
      },
    )
```

with:

```ts
    const response = await binding.provider.fetch(
      "messages_count_tokens",
      { method: "POST", body: JSON.stringify(payload) },
      {
        operationName: "count tokens",
        extraHeaders: extractAnthropicPassthroughHeaders(ctx),
      },
    )
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/routes/messages/index.ts
git commit -m "refactor(messages/count): dispatch via provider.fetch('messages_count_tokens', ...)"
```

---

## Task 10: Migrate src/routes/gemini.ts (count_tokens at line 235)

**Files:**
- Modify: `src/routes/gemini.ts:235-238`

- [ ] **Step 1: Apply transform**

Replace:

```ts
  const response = await binding.provider.callMessagesCountTokens(
    payload as unknown as Record<string, unknown>,
    { operationName: "gemini count tokens" },
  )
```

with:

```ts
  const response = await binding.provider.fetch(
    "messages_count_tokens",
    { method: "POST", body: JSON.stringify(payload) },
    { operationName: "gemini count tokens" },
  )
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/routes/gemini.ts
git commit -m "refactor(gemini/count): dispatch via provider.fetch('messages_count_tokens', ...)"
```

---

## Task 11: Update tests/provider-binding.test.ts inline mock

**Files:**
- Modify: `tests/provider-binding.test.ts:11-12`

- [ ] **Step 1: Delete the two entries**

Delete from the inline minimal-provider mock:

```ts
  callMessages: () => Promise.resolve(new Response()),
  callMessagesCountTokens: () => Promise.resolve(new Response()),
```

After this edit, the mock should retain only: `kind`, `name`, `supportedEndpoints`, `getModels`, `probe`, `fetch`, `callEmbeddings`.

- [ ] **Step 2: Run binding test**

Run: `bun test tests/provider-binding.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/provider-binding.test.ts
git commit -m "test(provider-binding): remove callMessages/callMessagesCountTokens from inline mock"
```

---

## Task 12: Delete callMessages + callMessagesCountTokens wrappers from interface + 3 providers

**Files:**
- Modify: `src/providers/types.ts:41-42`
- Modify: `src/providers/copilot/provider.ts:52, 56` (two methods)
- Modify: `src/providers/custom/provider.ts:120, 124` (two methods)
- Modify: `src/providers/azure/provider.ts:129, 132` (two methods)

- [ ] **Step 1: Grep to confirm zero remaining callsites**

Run:

```bash
grep -rn "callMessages\|callMessagesCountTokens" /Users/zhangxian/projects/copilot-api-gateway/src /Users/zhangxian/projects/copilot-api-gateway/tests
```

Expected: Only declarations in interface + 3 providers (2 lines per file, 8 total). Anything else → apply Plan 3 recipe.

- [ ] **Step 2: Delete from interface (`src/providers/types.ts`)**

Delete both lines:

```ts
  /** @deprecated Use fetch('messages', ...). Removed in Plan 3. */
  callMessages(payload: Record<string, unknown>, opts?: ProviderCallOptions): Promise<Response>
  /** @deprecated Use fetch('messages_count_tokens', ...). Removed in Plan 3. */
  callMessagesCountTokens(payload: Record<string, unknown>, opts?: ProviderCallOptions): Promise<Response>
```

- [ ] **Step 3: Delete from CopilotProvider**

In `src/providers/copilot/provider.ts`, delete both methods. The `callMessagesCountTokens` wrapper has an extra `requireModel: false` opt that's no longer needed since Plan 0's `fetch()` defaults it for that endpoint:

```ts
  callMessages(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.fetch("messages", { method: "POST", body: JSON.stringify(payload) }, opts)
  }
  callMessagesCountTokens(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.fetch("messages_count_tokens", { method: "POST", body: JSON.stringify(payload) }, { ...opts, requireModel: false })
  }
```

Delete both. (The Plan 0 default `requireModel = opts.requireModel ?? (endpoint !== "messages_count_tokens")` continues to give the same behavior.)

- [ ] **Step 4: Delete from CustomProvider**

In `src/providers/custom/provider.ts`, delete both wrapper methods.

- [ ] **Step 5: Delete from AzureProvider**

In `src/providers/azure/provider.ts`, delete both wrapper methods.

- [ ] **Step 6: Final typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Full curated test suite + provider tests**

Run:

```bash
bun test tests/transforms.test.ts tests/formatter.test.ts tests/storage.test.ts tests/error.test.ts tests/interceptor.test.ts tests/provider-capability.test.ts tests/endpoint-key.test.ts tests/provider-binding.test.ts tests/provider-probe.test.ts tests/azure-provider.test.ts tests/custom-provider.test.ts tests/copilot-provider-variant.test.ts tests/chat-completions-stream-usage.test.ts tests/responses-stream-usage.test.ts tests/messages-gpt-stream-usage.test.ts tests/gemini-stream-usage.test.ts
```

Expected: All PASS.

- [ ] **Step 8: Commit**

```bash
git add src/providers/types.ts src/providers/copilot/provider.ts src/providers/custom/provider.ts src/providers/azure/provider.ts
git commit -m "refactor(providers): remove callMessages + callMessagesCountTokens wrappers

All callers now dispatch via provider.fetch('messages', ...) and
provider.fetch('messages_count_tokens', ...). One callXxx wrapper remains
(callEmbeddings); Plan 4 removes it."
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ All 8 production `callMessages` callsites migrated (messages/direct ×2, chat-cc-messages-fallback ×2, gemini-messages-fallback ×2, responses-messages-fallback ×2, web-search ×2) — Tasks 1–5
- ✅ All 2 production `callMessagesCountTokens` callsites migrated (messages/index, gemini.ts) — Tasks 9, 10
- ✅ 2 stream-usage test mocks updated — Task 6
- ✅ 3 copilot-variant direct calls migrated — Task 7
- ✅ 2 azure-provider direct calls migrated (happy + error path) — Task 8
- ✅ provider-binding inline mock cleaned — Task 11
- ✅ Both wrappers removed from interface + 3 providers — Task 12
- ✅ Full curated suite re-run at end — Task 12 Step 7

**Placeholder scan:**
- `<literal>` in Tasks 2, 3 — explicitly instructed to copy operationName from file verbatim. Acceptable.
- `...payload literal...` in Task 7 — explicitly instructed to preserve verbatim. Acceptable.
- Task 12 Step 3 documents the Copilot `requireModel: false` removal with the exact Plan 0 default that takes over. Concrete reasoning, not deferred.

**Type consistency:**
- Endpoint key literals `"messages"` and `"messages_count_tokens"` match Plan 0's `EndpointKey` union.
- `init.body = JSON.stringify(payload)` everywhere → matches Plan 0's `parseJsonBody`.
- `extraHeaders` opt preserved verbatim in messages/direct, web-search, messages/index — matches `ProviderFetchOptions extends ProviderCallOptions` (which carries `extraHeaders`).
- Test mock `supportedEndpoints` array grows to include `"messages"` consistently across both stream-usage files.

---

## After Plan 3 lands

Next: **Plan 4** — `callEmbeddings` migration (smallest: only 1 production caller in `src/routes/embeddings.ts`, plus the Custom test at `tests/custom-provider.test.ts:67`). After Plan 4, the `ModelProvider` interface is purely capability-declarative and the deprecated `ModelEndpoint` alias from Plan 0 can also be removed.
