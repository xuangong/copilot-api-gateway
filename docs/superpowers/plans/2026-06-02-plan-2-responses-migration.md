# Plan 2: responses Caller Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate every `provider.callResponses(payload, opts)` callsite to `provider.fetch("responses", { method: "POST", body: JSON.stringify(payload) }, opts)`, then delete the `callResponses` wrapper from the `ModelProvider` interface and all three provider implementations.

**Architecture:** Same mechanical pattern as Plan 1, applied to the `/responses` endpoint surface. 8 production callsites and 5 test-mock entries. After this plan, 3 `callXxx` methods remain (messages, messages_count_tokens, embeddings).

**Tech Stack:** Bun runtime + TypeScript. Caller files in `src/routes/{chat-completions-responses-fallback,gemini-responses-fallback,messages/responses-fallback,responses/direct}.ts`. Test mocks in `tests/{provider-binding,chat-completions-stream-usage,messages-gpt-stream-usage,gemini-stream-usage,responses-stream-usage,copilot-provider-variant}.test.ts`.

---

## File Structure

**Caller files modified (production code, 4 files, 8 callsites):**
- `src/routes/responses/direct.ts:54` and `:135` — main /responses route, stream + non-stream
- `src/routes/chat-completions-responses-fallback.ts:70` and `:109` — chat-completions → responses fallback (stream + non-stream)
- `src/routes/gemini-responses-fallback.ts:68` and `:116` — gemini → responses fallback (stream + non-stream)
- `src/routes/messages/responses-fallback.ts:58` and `:96` — messages → responses fallback (stream + non-stream)

**Test files modified (6 files):**
- `tests/provider-binding.test.ts` — delete `callResponses` entry from inline mock
- `tests/chat-completions-stream-usage.test.ts` — fold `callResponses` stub into the `fetch` shim
- `tests/messages-gpt-stream-usage.test.ts` — same
- `tests/gemini-stream-usage.test.ts` — same
- `tests/responses-stream-usage.test.ts` — same (primary regression coverage)
- `tests/copilot-provider-variant.test.ts:106` — migrate direct call to `fetch("responses", ...)`

**Files modified (interface + implementations, 4 files):**
- `src/providers/types.ts` — delete `callResponses` line from `ModelProvider`
- `src/providers/copilot/provider.ts:48` — delete wrapper method
- `src/providers/custom/provider.ts:116` — delete wrapper method
- `src/providers/azure/provider.ts:126` — delete wrapper method

**Untouched (intentionally):**
- Production callsites for `callMessages` / `callMessagesCountTokens` / `callEmbeddings` — Plans 3 + 4.
- Test mocks for those 3 methods stay in place until their plans.

---

## Migration Recipe

Identical to Plan 1, but with `"responses"` as the endpoint key.

**Before:**
```ts
const response = await provider.callResponses(
  payload as unknown as Record<string, unknown>,
  { operationName: "responses" },
)
```

**After:**
```ts
const response = await provider.fetch(
  "responses",
  { method: "POST", body: JSON.stringify(payload) },
  { operationName: "responses" },
)
```

For sites wrapped in `withConnectionMismatchRetry((p) => provider.callResponses(p, opts))`, the inner lambda becomes `(p) => provider.fetch("responses", { method: "POST", body: JSON.stringify(p) }, opts)`. The retry helper signature is unchanged.

---

## Task 1: Migrate src/routes/responses/direct.ts

**Files:**
- Modify: `src/routes/responses/direct.ts:54` and `:135`

- [ ] **Step 1: Read lines 45-140 to capture both callsite shapes**

Run: `sed -n '45,145p' src/routes/responses/direct.ts`
Confirm both calls match the `withConnectionMismatchRetry((p) => provider.callResponses(p, { operationName: "responses" }))` pattern at lines 54 and 135.

- [ ] **Step 2: Apply transform to line 54 region**

Replace:

```ts
      (p) => provider.callResponses(p as Record<string, unknown>, { operationName: "responses" }),
```

with:

```ts
      (p) => provider.fetch(
        "responses",
        { method: "POST", body: JSON.stringify(p) },
        { operationName: "responses" },
      ),
```

- [ ] **Step 3: Apply identical transform to line 135 region**

Same replacement.

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Run responses stream-usage test**

Run: `bun test tests/responses-stream-usage.test.ts`
Expected: PASS today (mock still has `callResponses`). Will need the mock update in Task 5 to keep passing after wrapper removal.

- [ ] **Step 6: Commit**

```bash
git add src/routes/responses/direct.ts
git commit -m "refactor(responses): dispatch via provider.fetch('responses', ...)"
```

---

## Task 2: Migrate src/routes/chat-completions-responses-fallback.ts

**Files:**
- Modify: `src/routes/chat-completions-responses-fallback.ts:70` and `:109`

- [ ] **Step 1: Read lines 60-115 to capture both call shapes**

Run: `sed -n '60,115p' src/routes/chat-completions-responses-fallback.ts`
Confirm both calls use `withConnectionMismatchRetry((p) => provider.callResponses(p, { operationName: <something> }))`.

- [ ] **Step 2: Apply transform to both callsites**

For each, replace:

```ts
      (p) => provider.callResponses(p as Record<string, unknown>, {
        operationName: <operationNameLiteral>,
      }),
```

with:

```ts
      (p) => provider.fetch(
        "responses",
        { method: "POST", body: JSON.stringify(p) },
        { operationName: <operationNameLiteral> },
      ),
```

Preserve `<operationNameLiteral>` verbatim from the original (it might be `"chat completions (via responses)"` or similar — copy from the file, do not invent).

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/routes/chat-completions-responses-fallback.ts
git commit -m "refactor(cc-responses-fallback): dispatch responses via provider.fetch()"
```

---

## Task 3: Migrate src/routes/gemini-responses-fallback.ts

**Files:**
- Modify: `src/routes/gemini-responses-fallback.ts:68` and `:116`

- [ ] **Step 1: Read lines 60-120 to capture both call shapes**

Run: `sed -n '60,120p' src/routes/gemini-responses-fallback.ts`
Confirm both callsites use the same wrapped-lambda shape.

- [ ] **Step 2: Apply transform to both callsites**

Same recipe as Task 2 — replace `provider.callResponses(p as Record<string, unknown>, { operationName: <literal> })` with `provider.fetch("responses", { method: "POST", body: JSON.stringify(p) }, { operationName: <literal> })`.

- [ ] **Step 3: Run gemini stream-usage test**

Run: `bun test tests/gemini-stream-usage.test.ts`
Expected: PASS (with the test mock still exposing `callResponses` — fixed in Task 5).

- [ ] **Step 4: Commit**

```bash
git add src/routes/gemini-responses-fallback.ts
git commit -m "refactor(gemini-responses-fallback): dispatch via provider.fetch('responses', ...)"
```

---

## Task 4: Migrate src/routes/messages/responses-fallback.ts

**Files:**
- Modify: `src/routes/messages/responses-fallback.ts:58` and `:96`

- [ ] **Step 1: Apply transform to line 58**

Replace:

```ts
      (p) => provider.callResponses(p as Record<string, unknown>, { operationName: "messages (via responses)" }),
```

with:

```ts
      (p) => provider.fetch(
        "responses",
        { method: "POST", body: JSON.stringify(p) },
        { operationName: "messages (via responses)" },
      ),
```

- [ ] **Step 2: Apply identical transform to line 96**

Same replacement.

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/routes/messages/responses-fallback.ts
git commit -m "refactor(messages-responses-fallback): dispatch via provider.fetch('responses', ...)"
```

---

## Task 5: Update all stream-usage test mocks

**Files:**
- Modify: `tests/chat-completions-stream-usage.test.ts:17-32` (after Plan 1's update)
- Modify: `tests/messages-gpt-stream-usage.test.ts:17-32`
- Modify: `tests/gemini-stream-usage.test.ts:17-32`
- Modify: `tests/responses-stream-usage.test.ts:17-32`

After Plan 1, the chat/messages mocks look like:

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

(The gemini/responses mocks may still have the pre-Plan-1 shape with both `callChatCompletions` and `callResponses` as keys, or only `callResponses`. Check the file before editing.)

- [ ] **Step 1: Read each mock to see its current shape**

Run: `sed -n '15,35p' tests/chat-completions-stream-usage.test.ts tests/messages-gpt-stream-usage.test.ts tests/gemini-stream-usage.test.ts tests/responses-stream-usage.test.ts`

- [ ] **Step 2: For each file, remove the `callResponses` key from the mock object**

The `fetch` shim already handles `endpoint === "responses"` (Plan 1 already added it where needed). For files where the mock currently has only `callResponses` (e.g. responses-stream-usage if it predates Plan 1), apply the full Plan-1-style transform:

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
  }),
}))
```

For files already in Plan-1 shape, simply delete the trailing `callResponses: async () => { ... }` block.

- [ ] **Step 3: Run all four affected stream-usage tests**

Run:

```bash
bun test tests/chat-completions-stream-usage.test.ts tests/messages-gpt-stream-usage.test.ts tests/gemini-stream-usage.test.ts tests/responses-stream-usage.test.ts
```

Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/chat-completions-stream-usage.test.ts tests/messages-gpt-stream-usage.test.ts tests/gemini-stream-usage.test.ts tests/responses-stream-usage.test.ts
git commit -m "test(stream-usage): swap callResponses mocks to fetch() surface"
```

---

## Task 6: Migrate tests/copilot-provider-variant.test.ts direct call

**Files:**
- Modify: `tests/copilot-provider-variant.test.ts:106` (and any nearby identical pattern)

- [ ] **Step 1: Read lines 95-130 to see the exact assertion shape**

Run: `sed -n '95,130p' tests/copilot-provider-variant.test.ts`

- [ ] **Step 2: Replace the direct callResponses call**

Replace:

```ts
    await provider().callResponses({
      ...payload literal...
    })
```

with:

```ts
    await provider().fetch(
      "responses",
      { method: "POST", body: JSON.stringify({
        ...payload literal...
      }) },
    )
```

Preserve the original payload literal verbatim — only wrap it in `JSON.stringify(...)` and add the endpoint key.

- [ ] **Step 3: Run the variant test**

Run: `bun test tests/copilot-provider-variant.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/copilot-provider-variant.test.ts
git commit -m "test(copilot-variant): migrate responses assertions to fetch() surface"
```

---

## Task 7: Update tests/provider-binding.test.ts inline mock

**Files:**
- Modify: `tests/provider-binding.test.ts:10`

- [ ] **Step 1: Delete the `callResponses` entry**

The Plan-1-updated mock has:

```ts
{
  ...
  fetch: () => Promise.resolve(new Response()),
  callResponses: () => Promise.resolve(new Response()),
  callMessages: () => Promise.resolve(new Response()),
  callMessagesCountTokens: () => Promise.resolve(new Response()),
  callEmbeddings: () => Promise.resolve(new Response()),
}
```

Delete the `callResponses` line.

- [ ] **Step 2: Run binding test**

Run: `bun test tests/provider-binding.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/provider-binding.test.ts
git commit -m "test(provider-binding): remove callResponses entry from inline mock"
```

---

## Task 8: Delete callResponses wrapper from interface + 3 providers

**Files:**
- Modify: `src/providers/types.ts:40` — delete the `callResponses` line
- Modify: `src/providers/copilot/provider.ts:48` — delete the 3-line wrapper method
- Modify: `src/providers/custom/provider.ts:116` — delete the 3-line wrapper method
- Modify: `src/providers/azure/provider.ts:126` — delete the 3-line wrapper method

- [ ] **Step 1: Grep to confirm zero remaining callsites**

Run: `grep -rn "callResponses" /Users/zhangxian/projects/copilot-api-gateway/src /Users/zhangxian/projects/copilot-api-gateway/tests`
Expected: Only the 4 declarations (interface + 3 providers). If any callsite remains, apply the Plan 2 recipe and re-grep.

- [ ] **Step 2: Delete from interface (`src/providers/types.ts`)**

Delete:

```ts
  /** @deprecated Use fetch('responses', ...). Removed in Plan 2. */
  callResponses(payload: Record<string, unknown>, opts?: ProviderCallOptions): Promise<Response>
```

- [ ] **Step 3: Delete from CopilotProvider (`src/providers/copilot/provider.ts`)**

Delete:

```ts
  callResponses(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.fetch("responses", { method: "POST", body: JSON.stringify(payload) }, opts)
  }
```

- [ ] **Step 4: Delete from CustomProvider (`src/providers/custom/provider.ts`)**

Same 3-line delete.

- [ ] **Step 5: Delete from AzureProvider (`src/providers/azure/provider.ts`)**

Same 3-line delete.

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
git commit -m "refactor(providers): remove callResponses wrapper

All callers now dispatch via provider.fetch('responses', ...).
Three callXxx wrappers remain; Plans 3-4 will remove them."
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ All 8 production callsites migrated (responses/direct ×2, chat-completions-responses-fallback ×2, gemini-responses-fallback ×2, messages/responses-fallback ×2) — Tasks 1–4
- ✅ All 4 stream-usage test mocks updated — Task 5
- ✅ copilot-provider-variant direct call migrated — Task 6
- ✅ provider-binding inline mock updated — Task 7
- ✅ `callResponses` removed from interface + 3 providers — Task 8
- ✅ Full curated suite re-run at end — Task 8 Step 7

**Placeholder scan:**
- Task 5 says "Check the file before editing" with two clear sub-cases (full transform vs delete-the-trailing-block). Concrete conditional, not a TODO.
- `<operationNameLiteral>` placeholder in Task 2 — explicitly instructed to copy from the original file verbatim, never invent. Acceptable: the literal varies per-callsite, so a generic recipe is correct.
- Task 6 Step 2 uses `...payload literal...` — explicitly instructed to preserve verbatim. Acceptable.

**Type consistency:**
- Every `fetch()` call uses literal `"responses"`.
- `init.body` is `JSON.stringify(payload)` matching Plan 0's `parseJsonBody`.
- All test mocks expose `supportedEndpoints` + `fetch` consistent with Plan 0 + Plan 1.
- `withConnectionMismatchRetry` lambda signature `(payload) => Promise<Response>` preserved.

---

## After Plan 2 lands

Next: **Plan 3** — `callMessages` + `callMessagesCountTokens` paired together (they share Copilot's variant pipeline). Largest remaining migration because messages has the most caller surface (Anthropic-shaped routes, Gemini fallback, etc.).
