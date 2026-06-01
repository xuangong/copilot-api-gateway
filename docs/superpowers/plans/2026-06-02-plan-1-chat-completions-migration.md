# Plan 1: chat_completions Caller Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate every `provider.callChatCompletions(payload, opts)` callsite to `provider.fetch("chat_completions", { method: "POST", body: JSON.stringify(payload) }, opts)`, then delete the `callChatCompletions` wrapper from the `ModelProvider` interface and all three provider implementations.

**Architecture:** Plan 0 already shipped `fetch()` as the canonical dispatch method, with `callChatCompletions` left as a thin wrapper. This plan does mechanical search-and-replace on every caller, updates test mocks to expose `fetch` instead of `callChatCompletions`, then removes the wrapper. After this plan there are 4 `callXxx` methods left.

**Tech Stack:** Bun runtime + TypeScript. Existing caller files in `src/routes/**` and `src/services/web-search/openai-interceptor.ts`. Test mocks in `tests/provider-binding.test.ts`, `tests/chat-completions-stream-usage.test.ts`, `tests/messages-gpt-stream-usage.test.ts`, `tests/custom-provider.test.ts`, `tests/copilot-provider-variant.test.ts`, `tests/azure-provider.test.ts`.

---

## File Structure

**Caller files modified (production code, 6 files, 9 callsites):**
- `src/routes/chat-completions.ts:213` and `:258` — main chat_completions route, stream + non-stream
- `src/routes/gemini.ts:162` and `:353` — Gemini → chat_completions adapter
- `src/routes/messages/chat-completions-fallback.ts:63` and `:102` — messages-via-chat fallback (stream + non-stream)
- `src/routes/responses/chat-fallback.ts:73` and `:118` — responses-via-chat fallback (stream + non-stream)
- `src/services/web-search/openai-interceptor.ts:174` — web-search interceptor (non-stream only)

**Test files modified (6 files):**
- `tests/provider-binding.test.ts` — change inline mock from `callChatCompletions` to `fetch`
- `tests/chat-completions-stream-usage.test.ts` — change `mock.module` stub to expose `fetch`
- `tests/messages-gpt-stream-usage.test.ts` — same
- `tests/custom-provider.test.ts` — rename test cases that exercise `callChatCompletions` to exercise `fetch("chat_completions", ...)`
- `tests/copilot-provider-variant.test.ts` — same
- `tests/azure-provider.test.ts` — same

**Files modified (interface + implementations, 4 files):**
- `src/providers/types.ts` — delete the `callChatCompletions` line from `ModelProvider`
- `src/providers/copilot/provider.ts` — delete the `callChatCompletions` wrapper method
- `src/providers/custom/provider.ts` — delete the `callChatCompletions` wrapper method
- `src/providers/azure/provider.ts` — delete the `callChatCompletions` wrapper method

**Untouched (intentionally):**
- Plan 0 capability tests in `tests/provider-capability.test.ts` and `tests/endpoint-key.test.ts`.
- The other 4 `callXxx` methods — they stay until Plans 2/3/4.

---

## Migration Recipe

Every callsite follows the same transform:

**Before:**
```ts
const response = await provider.callChatCompletions(
  payload as unknown as Record<string, unknown>,
  { operationName: "chat completions" },
)
```

**After:**
```ts
const response = await provider.fetch(
  "chat_completions",
  { method: "POST", body: JSON.stringify(payload) },
  { operationName: "chat completions" },
)
```

Rules:
1. The `payload as unknown as Record<string, unknown>` cast becomes a `JSON.stringify(payload)` call inside `init.body`. The Plan 0 `fetch()` re-parses the body internally via `parseJsonBody`, so the wire payload is identical.
2. The `opts` argument (operationName, extraHeaders, timeout, requireModel) is forwarded unchanged.
3. When the caller wraps the call in `withConnectionMismatchRetry((p) => provider.callChatCompletions(p, opts))`, the inner lambda becomes `(p) => provider.fetch("chat_completions", { method: "POST", body: JSON.stringify(p) }, opts)`. The retry helper keeps its `(payload) => Promise<Response>` shape — only the lambda body changes.

---

## Task 1: Migrate src/routes/chat-completions.ts

**Files:**
- Modify: `src/routes/chat-completions.ts:213-216` and `:258-261`

- [ ] **Step 1: Write the failing test**

Append to `tests/chat-completions-stream-usage.test.ts` (where the existing `mock.module` stub is at line 17-28). Add a new test that asserts the route calls `fetch("chat_completions", ...)`:

```ts
test("chat completions route dispatches via provider.fetch('chat_completions', ...)", async () => {
  const calls: Array<{ endpoint: string; bodyParsed: unknown }> = []
  mock.module("~/providers/registry", () => ({
    createCopilotProvider: () => ({
      supportedEndpoints: ["chat_completions"],
      fetch: async (endpoint: string, init: RequestInit) => {
        calls.push({ endpoint, bodyParsed: JSON.parse(init.body as string) })
        return new Response("data: [DONE]\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        })
      },
    }),
  }))
  // The rest of the existing harness drives a request through the route.
  // After this test runs, expect:
  expect(calls.length).toBeGreaterThan(0)
  expect(calls[0]!.endpoint).toBe("chat_completions")
  expect((calls[0]!.bodyParsed as { stream: boolean }).stream).toBe(true)
})
```

(If the existing test harness is hard to invoke directly, this Step is optional — the existing stream-usage assertions are sufficient regression coverage. The required minimum is Step 2's mock update.)

- [ ] **Step 2: Run existing tests to confirm they still fail or need mock update**

Run: `bun test tests/chat-completions-stream-usage.test.ts`
Expected: PASS today (because `callChatCompletions` still works). After Step 4 below renames the mock, this test will pass only if the migration is done.

- [ ] **Step 3: Migrate the two callsites in `src/routes/chat-completions.ts`**

Replace lines 213-216:

```ts
    const response = await provider.callChatCompletions(
      payload as unknown as Record<string, unknown>,
      { operationName: "chat completions" },
    )
```

with:

```ts
    const response = await provider.fetch(
      "chat_completions",
      { method: "POST", body: JSON.stringify(payload) },
      { operationName: "chat completions" },
    )
```

Replace lines 258-261:

```ts
    const response = await provider.callChatCompletions(
      payload as unknown as Record<string, unknown>,
      { operationName: "chat completions" },
    )
```

with:

```ts
    const response = await provider.fetch(
      "chat_completions",
      { method: "POST", body: JSON.stringify(payload) },
      { operationName: "chat completions" },
    )
```

- [ ] **Step 4: Update the test mock**

In `tests/chat-completions-stream-usage.test.ts` lines 17-28, replace:

```ts
mock.module("~/providers/registry", () => ({
  createCopilotProvider: () => ({
    callChatCompletions: async () => {
      if (!upstreamResponse) throw new Error("missing upstream response")
      return upstreamResponse
    },
    callResponses: async () => {
      if (!upstreamResponse) throw new Error("missing upstream response")
      return upstreamResponse
    },
  }),
}))
```

with:

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
    callResponses: async () => {
      if (!upstreamResponse) throw new Error("missing upstream response")
      return upstreamResponse
    },
  }),
}))
```

(`callResponses` stays for now — Plan 2 removes it.)

- [ ] **Step 5: Run the suite**

Run: `bun test tests/chat-completions-stream-usage.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/chat-completions.ts tests/chat-completions-stream-usage.test.ts
git commit -m "refactor(chat-completions): dispatch via provider.fetch('chat_completions', ...)"
```

---

## Task 2: Migrate src/routes/gemini.ts

**Files:**
- Modify: `src/routes/gemini.ts:162-165` and `:353-356`

- [ ] **Step 1: Migrate callsite at line 162**

Read lines 158-168, identify the `await provider.callChatCompletions(...)` block, and replace the call with:

```ts
    const response = await provider.fetch(
      "chat_completions",
      { method: "POST", body: JSON.stringify(payload) },
      <opts unchanged>,
    )
```

Preserve the existing `opts` object verbatim.

- [ ] **Step 2: Migrate callsite at line 353**

Same transform for `binding.provider.callChatCompletions(...)` → `binding.provider.fetch("chat_completions", { method: "POST", body: JSON.stringify(payload) }, <opts unchanged>)`.

- [ ] **Step 3: Run gemini test**

Run: `bun test tests/gemini-stream-usage.test.ts`
Expected: PASS (the mock in this file already uses `callResponses`-style; check whether it needs the same fetch-shim treatment).

If `tests/gemini-stream-usage.test.ts` mock still references `callChatCompletions`, apply the same mock-update pattern from Task 1 Step 4 to it.

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/routes/gemini.ts tests/gemini-stream-usage.test.ts
git commit -m "refactor(gemini): dispatch chat_completions calls via provider.fetch()"
```

---

## Task 3: Migrate src/routes/messages/chat-completions-fallback.ts

**Files:**
- Modify: `src/routes/messages/chat-completions-fallback.ts:63-65` and `:102-104`

This file wraps the calls inside `withConnectionMismatchRetry((p) => provider.callChatCompletions(...))`. The inner lambda must be rewritten.

- [ ] **Step 1: Migrate stream branch (line 61-66)**

Replace:

```ts
    const upstream = await withConnectionMismatchRetry(
      chatPayload as unknown as Record<string, unknown>,
      (p) => provider.callChatCompletions(p as Record<string, unknown>, {
        operationName: "messages (via chat completions)",
      }),
    )
```

with:

```ts
    const upstream = await withConnectionMismatchRetry(
      chatPayload as unknown as Record<string, unknown>,
      (p) => provider.fetch(
        "chat_completions",
        { method: "POST", body: JSON.stringify(p) },
        { operationName: "messages (via chat completions)" },
      ),
    )
```

- [ ] **Step 2: Migrate non-stream branch (line 100-105)**

Apply the identical transform to the second `withConnectionMismatchRetry` call.

- [ ] **Step 3: Run the messages stream-usage test**

Run: `bun test tests/messages-gpt-stream-usage.test.ts`
Expected: PASS today (mock still has `callChatCompletions`). After updating the mock below this should also pass.

- [ ] **Step 4: Update the test mock**

In `tests/messages-gpt-stream-usage.test.ts` lines 17-28 (or wherever the `mock.module` block is), apply the same fetch-shim transform from Task 1 Step 4.

- [ ] **Step 5: Re-run**

Run: `bun test tests/messages-gpt-stream-usage.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/messages/chat-completions-fallback.ts tests/messages-gpt-stream-usage.test.ts
git commit -m "refactor(messages-fallback): dispatch chat_completions via provider.fetch()"
```

---

## Task 4: Migrate src/routes/responses/chat-fallback.ts

**Files:**
- Modify: `src/routes/responses/chat-fallback.ts:73` and `:118`

- [ ] **Step 1: Read lines 65-130 to capture both call shapes**

Identify the exact `opts` object for each callsite. They might both look like:

```ts
const response = await provider.callChatCompletions(
  payload as unknown as Record<string, unknown>,
  { operationName: "responses (via chat completions)" },
)
```

- [ ] **Step 2: Apply the transform to both callsites**

Each becomes:

```ts
const response = await provider.fetch(
  "chat_completions",
  { method: "POST", body: JSON.stringify(payload) },
  { operationName: "responses (via chat completions)" },
)
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/routes/responses/chat-fallback.ts
git commit -m "refactor(responses-fallback): dispatch chat_completions via provider.fetch()"
```

---

## Task 5: Migrate src/services/web-search/openai-interceptor.ts

**Files:**
- Modify: `src/services/web-search/openai-interceptor.ts:174-177`

- [ ] **Step 1: Apply the transform**

Replace lines 174-177:

```ts
  const response = await createCopilotProvider({ copilotToken: options.copilotToken, accountType: options.accountType }).callChatCompletions(
    { ...payload, stream: false } as unknown as Record<string, unknown>,
    { operationName: "chat completions (web_search intercept)", extraHeaders: options.extraHeaders },
  )
```

with:

```ts
  const response = await createCopilotProvider({
    copilotToken: options.copilotToken,
    accountType: options.accountType,
  }).fetch(
    "chat_completions",
    { method: "POST", body: JSON.stringify({ ...payload, stream: false }) },
    { operationName: "chat completions (web_search intercept)", extraHeaders: options.extraHeaders },
  )
```

- [ ] **Step 2: Run web-search tests**

Run: `bun test tests/interceptor.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/services/web-search/openai-interceptor.ts
git commit -m "refactor(web-search): dispatch chat_completions via provider.fetch()"
```

---

## Task 6: Migrate provider unit tests to call fetch() directly

**Files:**
- Modify: `tests/custom-provider.test.ts:45-58`
- Modify: `tests/copilot-provider-variant.test.ts:95-110, 149-165`
- Modify: `tests/azure-provider.test.ts:53-65`

These tests directly call `p.callChatCompletions(...)` on a real provider instance to assert wire behavior. They must call `p.fetch("chat_completions", ...)` instead — testing the canonical surface, not the wrapper that's about to be deleted.

- [ ] **Step 1: Migrate custom-provider test**

In `tests/custom-provider.test.ts` line 45-58 (the `callChatCompletions sends bearer auth and POST body` test):

Rename the test to `"fetch('chat_completions') sends bearer auth and POST body"`. Replace:

```ts
    await p.callChatCompletions({ model: "x", messages: [] })
```

with:

```ts
    await p.fetch(
      "chat_completions",
      { method: "POST", body: JSON.stringify({ model: "x", messages: [] }) },
    )
```

- [ ] **Step 2: Migrate copilot-provider-variant tests**

In `tests/copilot-provider-variant.test.ts` line 95 and line 149, replace each `await provider().callChatCompletions(payload, opts)` with:

```ts
    await provider().fetch(
      "chat_completions",
      { method: "POST", body: JSON.stringify(payload) },
      opts,
    )
```

(The variable name `payload` matches whatever object literal the original test passes — preserve it verbatim.)

- [ ] **Step 3: Migrate azure-provider test**

In `tests/azure-provider.test.ts` line 57, replace:

```ts
    await p.callChatCompletions({ messages: [] })
```

with:

```ts
    await p.fetch(
      "chat_completions",
      { method: "POST", body: JSON.stringify({ messages: [] }) },
    )
```

- [ ] **Step 4: Run provider unit tests**

Run: `bun test tests/custom-provider.test.ts tests/copilot-provider-variant.test.ts tests/azure-provider.test.ts`
Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/custom-provider.test.ts tests/copilot-provider-variant.test.ts tests/azure-provider.test.ts
git commit -m "test(providers): migrate chat_completions assertions to fetch() surface"
```

---

## Task 7: Update tests/provider-binding.test.ts inline mock

**Files:**
- Modify: `tests/provider-binding.test.ts:5-15` (the inline minimal-provider mock)

- [ ] **Step 1: Read lines 1-25 to see current mock shape**

The current mock at line 9 has:

```ts
  callChatCompletions: () => Promise.resolve(new Response()),
```

It's a minimal stub used by binding-layer tests. After this plan removes `callChatCompletions` from the interface, this stub must instead provide `supportedEndpoints` + `fetch`.

- [ ] **Step 2: Replace the mock**

Replace the existing minimal-provider literal with:

```ts
{
  kind: "copilot",
  name: "stub",
  supportedEndpoints: ["chat_completions", "responses", "messages", "messages_count_tokens", "embeddings"],
  getModels: () => Promise.resolve({ object: "list", data: [] }),
  probe: () => Promise.resolve({ ok: true }),
  fetch: () => Promise.resolve(new Response()),
  callResponses: () => Promise.resolve(new Response()),
  callMessages: () => Promise.resolve(new Response()),
  callMessagesCountTokens: () => Promise.resolve(new Response()),
  callEmbeddings: () => Promise.resolve(new Response()),
}
```

(Keep the other 4 `callXxx` until their respective plans delete them.)

- [ ] **Step 3: Run binding test**

Run: `bun test tests/provider-binding.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/provider-binding.test.ts
git commit -m "test(provider-binding): swap inline mock to fetch() shape"
```

---

## Task 8: Delete the callChatCompletions wrapper from interface + 3 providers

**Files:**
- Modify: `src/providers/types.ts` — delete the `callChatCompletions` line
- Modify: `src/providers/copilot/provider.ts` — delete the `callChatCompletions` wrapper method (~3 lines)
- Modify: `src/providers/custom/provider.ts` — delete the `callChatCompletions` wrapper method
- Modify: `src/providers/azure/provider.ts` — delete the `callChatCompletions` wrapper method

- [ ] **Step 1: Grep one more time to confirm zero callsites remain**

Run: `grep -rn "callChatCompletions" /Users/zhangxian/projects/copilot-api-gateway/src /Users/zhangxian/projects/copilot-api-gateway/tests`
Expected: Only the 4 declarations (interface + 3 providers) plus possibly `tests/provider-binding.test.ts` if it still has the entry — if so, remove that entry in this task.

- [ ] **Step 2: Delete from interface**

In `src/providers/types.ts`, delete the line:

```ts
  /** @deprecated Use fetch('chat_completions', ...). Removed in Plan 1. */
  callChatCompletions(payload: Record<string, unknown>, opts?: ProviderCallOptions): Promise<Response>
```

- [ ] **Step 3: Delete from CopilotProvider**

In `src/providers/copilot/provider.ts`, delete the entire `callChatCompletions` method (3 lines):

```ts
  callChatCompletions(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.fetch("chat_completions", { method: "POST", body: JSON.stringify(payload) }, opts)
  }
```

- [ ] **Step 4: Delete from CustomProvider**

In `src/providers/custom/provider.ts`, delete the identical 3-line method.

- [ ] **Step 5: Delete from AzureProvider**

In `src/providers/azure/provider.ts`, delete the identical 3-line method.

- [ ] **Step 6: Remove the `callChatCompletions` entry from tests/provider-binding.test.ts if it remains**

If Step 1 reported it, delete the line from the minimal mock object literal.

- [ ] **Step 7: Final typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors. (If any are reported, they are callsites Step 1 missed — fix them by applying the migration recipe, then re-run.)

- [ ] **Step 8: Full curated test suite + provider tests**

Run:

```bash
bun test tests/transforms.test.ts tests/formatter.test.ts tests/storage.test.ts tests/error.test.ts tests/interceptor.test.ts tests/provider-capability.test.ts tests/endpoint-key.test.ts tests/provider-binding.test.ts tests/provider-probe.test.ts tests/azure-provider.test.ts tests/custom-provider.test.ts tests/copilot-provider-variant.test.ts tests/chat-completions-stream-usage.test.ts tests/responses-stream-usage.test.ts tests/messages-gpt-stream-usage.test.ts tests/gemini-stream-usage.test.ts
```

Expected: All PASS.

- [ ] **Step 9: Commit**

```bash
git add src/providers/types.ts src/providers/copilot/provider.ts src/providers/custom/provider.ts src/providers/azure/provider.ts tests/provider-binding.test.ts
git commit -m "refactor(providers): remove callChatCompletions wrapper

All callers now dispatch via provider.fetch('chat_completions', ...).
Four callXxx wrappers remain; subsequent plans will remove them."
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ All 9 production callsites of `callChatCompletions` migrated (chat-completions ×2, gemini ×2, messages-fallback ×2, responses-fallback ×2, web-search ×1) — Tasks 1–5
- ✅ All 3 provider-unit-test direct calls migrated — Task 6
- ✅ Binding test mock updated — Task 7
- ✅ Stream-usage test mocks updated — Tasks 1 + 3
- ✅ `callChatCompletions` removed from interface + 3 providers — Task 8
- ✅ Full curated suite re-run at end — Task 8 Step 8

**Placeholder scan:**
- "If the existing test harness is hard to invoke directly, this Step is optional" — Task 1 Step 1 is explicitly marked optional with a fallback. Not a placeholder.
- Task 2 Step 1 says "Read lines 158-168 ... and replace the call with" — provides the exact replacement skeleton and instructs to preserve existing opts verbatim. Concrete.
- Task 2 Step 3 conditional "If `tests/gemini-stream-usage.test.ts` mock still references `callChatCompletions`, apply ..." — concrete conditional with linked recipe.

**Type consistency:**
- Every `fetch()` call uses the literal string `"chat_completions"` — matches `EndpointKey` union from Plan 0.
- `init.body` is always `JSON.stringify(payload)` — matches Plan 0's `parseJsonBody` expectation.
- `opts` object kept verbatim — matches `ProviderFetchOptions extends ProviderCallOptions` from Plan 0.
- Test mocks expose `supportedEndpoints` + `fetch` matching the Plan 0 interface shape.

---

## After Plan 1 lands

Next: **Plan 2** — same recipe applied to `callResponses` (5 callsites in chat-completions.ts/gemini.ts/responses/direct.ts/etc.). Mechanical.
