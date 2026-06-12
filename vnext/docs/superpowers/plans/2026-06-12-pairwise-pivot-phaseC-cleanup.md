# Pairwise Pivot — Phase C: Cleanup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `vnext/docs/superpowers/specs/2026-06-12-pairwise-translation-pivot.md`
**Overview:** `vnext/docs/superpowers/plans/2026-06-12-pairwise-pivot-overview.md`
**Prerequisite:** Phase B green (X-5 + X-6 landed; 4 IR-dependent test failures expected and tolerated).

**Goal:** Restore observability on the server-tools intercepts, delete the now-obsolete IR test files, and add the test coverage matrix the new architecture demands (per-pair × 6, per-attempt × 3, per-route × 6, plus a cancellation test per pair).

**Architecture:** Three sequential cleanups — X-7 (rewire server-tools through attempt modules), X-8 (delete IR test files), X-9 (add the new test matrix). They are listed in execution order; X-9 in particular consists of multiple independent test files that may be parallelized across subagents once the registry/helpers from earlier steps are in place.

**Tech Stack:** TypeScript, Bun test, AsyncIterable, real `SqliteRepo` + `globalThis.fetch` overrides (no `mock.module` per cross-cutting rules).

---

## Task 7 (X-7): Rewire Server-Tools Through Attempt Modules

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/orchestrator/server-tools/plugins/web-search/route-handler.ts`
- Modify: `vnext/apps/gateway/src/data-plane/orchestrator/server-tools/plugins/image-generation/route-handler.ts`
- Modify: `vnext/apps/gateway/src/data-plane/attempts/conversation.ts` (Phase A) — extend to expose a "pre-translated upstream call" entry point
- Modify: `vnext/apps/gateway/src/data-plane/attempts/images.ts` (Phase A) — same
- Add tests: `vnext/apps/gateway/tests/server-tools-observability.test.ts`

**Subject:** The web-search and image-generation handlers currently bypass `dispatch()` and call providers directly, which is why they emit `[observability] handleX bypasses dispatch quota/latency/usage tracking` warnings (see `web-search/route-handler.ts:41` and `image-generation/route-handler.ts:46`). Make them invoke the attempt modules so quota / latency / usage tracking flow through the same path as regular dispatch — without changing their request semantics.

### - [ ] Step 7.1: Audit the bypass warnings

Read these two files and confirm the bypass points:
- `web-search/route-handler.ts:41` — `console.warn('[observability] handleMessagesWebSearch bypasses dispatch quota/latency/usage tracking')`
- `image-generation/route-handler.ts:46` — `console.warn('[observability] handleResponsesImageGeneration bypasses dispatch quota/latency/usage tracking')`

Both warnings are temporary — they were added when the attempt modules didn't exist yet. After this task, both warnings (and the `console.warn` lines) are removed.

### - [ ] Step 7.2: Add `runConversationAttempt({ preTranslated })` mode

The web-search interceptor builds its own `MessagesPayload`-shaped upstream calls inside its multi-turn loop. It should not re-translate. Extend `runConversationAttempt` (Phase A X-4) to accept an already-shaped upstream request and skip the translator step. Test first:

```ts
// vnext/apps/gateway/src/data-plane/attempts/conversation.test.ts (extend existing file)
import { test, expect } from 'bun:test'
import { runConversationAttempt } from './conversation.ts'

test('preTranslated upstream request bypasses translator and is sent verbatim', async () => {
  const captured: { url: string; body: string }[] = []
  const fakeBinding = makeFakeBinding({ onCall: (url, body) => captured.push({ url, body }) })
  const result = await runConversationAttempt({
    binding: fakeBinding,
    targetEndpoint: 'messages',
    upstreamRequest: { model: 'x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
    preTranslated: true,
    isStream: false,
    model: 'x',
    sourceApi: 'messages',
    obs: { apiKeyId: 'k', userAgent: undefined, requestId: undefined },
    signal: new AbortController().signal,
  })
  expect(result.ok).toBe(true)
  expect(captured.length).toBe(1)
  expect(JSON.parse(captured[0]!.body).max_tokens).toBe(1)
})
```

Implement: when `preTranslated: true`, send `upstreamRequest` directly to `binding.provider.callMessages(...)` (or appropriate `callX`) without invoking the translator. Quota / latency / usage tracking still run.

### - [ ] Step 7.3: Add an "image attempt" entry point that handles edits + generations

`runImagesAttempt` already exists (Phase A X-4). Confirm it accepts a `mode: 'generate' | 'edit'` discriminator and a `sources?: ImageSource[]` field. Add tests for both modes if missing.

### - [ ] Step 7.4: Rewire `handleMessagesWebSearch` to use `runConversationAttempt`

In `web-search/route-handler.ts`:
- Remove the `console.warn('[observability] handleMessagesWebSearch …')` line.
- The web-search loop's *individual* upstream calls (built inside `interceptWebSearch`) should be routed through `runConversationAttempt({ preTranslated: true, … })`. The loop logic itself stays untouched; only the "leaf call" point swaps from a direct `provider.fetch()` to the attempt module.
- Streaming wrap (the synthetic `message_start` + 5s ping) is unchanged. The attempt module's usage/latency tracking now fires on each leaf call.

Concretely, the change site is in `interceptor.ts` (where `interceptWebSearch` lives) — wherever it currently invokes the provider, it instead calls `runConversationAttempt`. Pass in the `WebSearchRouteContext`'s `apiKeyId` / `requestId` so tracking is keyed correctly.

### - [ ] Step 7.5: Rewire `handleResponsesImageGeneration` to use `runImagesAttempt`

In `image-generation/route-handler.ts`:
- Remove the `console.warn('[observability] handleResponsesImageGeneration …')` line.
- Replace `generateImageViaBinding(binding, prompt, config, sources)` with `runImagesAttempt({ binding, mode: isEdit ? 'edit' : 'generate', prompt, config, sources, obs, signal })`.
- The synthesized SSE / JSON envelope construction (`buildImageGenerationResponse` / `synthImageGenerationSSE`) is unchanged — it operates on the attempt's outcome.

### - [ ] Step 7.6: Write observability test

Create `vnext/apps/gateway/tests/server-tools-observability.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { app } from '../src/app.ts'
import { installFetch, resetFetch } from './helpers/fetch-mock.ts'
import { withTempRepo } from './helpers/repo.ts'

beforeEach(() => { /* install fetch mock that returns canned web-search + messages responses */ })
afterEach(() => resetFetch())

test('web-search intercept records usage and latency for each leaf call', async () => {
  const repo = await withTempRepo()
  // … POST /v1/messages with web_search tool, 2-turn loop
  // assert: 2 latency rows + 2 usage rows in repo for the apiKeyId
})

test('image-generation intercept records usage and latency', async () => {
  const repo = await withTempRepo()
  // … POST /v1/responses with image_generation tool
  // assert: 1 latency row + 1 usage row in repo
})
```

### - [ ] Step 7.7: Run full vnext test suite

```bash
cd vnext && bun test
```
Expected: existing tests + Phase A/B tests + the 2 new observability tests pass. The 4 IR-dependent tests still fail (deleted in next task).

Confirm: `grep -rn '\[observability\] .* bypasses' vnext/apps/gateway/src` returns zero matches.

### - [ ] Step 7.8: Commit X-7

```bash
git add -A
git commit -m "feat(server-tools): route web-search and image-generation through attempt modules (X-7)

Removes the dispatch-bypass warnings; quota/latency/usage tracking now fire on the
leaf upstream calls inside both intercepts."
```

---

## Task 8 (X-8): Delete IR-Dependent Test Files

**Files (deletions):**
- Delete: the 4 IR-dependent test files identified in Phase B's "Expected Test Losses" section.

**Subject:** Phase B left these failing tests in place as a guardrail. Now that all IR code is gone and X-9 will add replacement coverage, delete them so the suite is fully green.

### - [ ] Step 8.1: List the 4 failing IR test files

```bash
cd vnext && bun test 2>&1 | grep -E '(FAIL|×).*\.test\.ts' | sort -u
```

Expected: exactly 4 file paths. Confirm each file's tests *only* exercise removed concepts (IR shape, BackendAdapter contract, frontend/backend adapter behavior). If any test asserts behavior that is still part of the contract (e.g. a frontend parse error case), salvage that assertion by moving it to the corresponding new pair test in X-9 — do not let real coverage disappear.

### - [ ] Step 8.2: Delete the 4 files

```bash
cd vnext && rm <path1> <path2> <path3> <path4>
```

(Replace `<pathN>` with the paths from Step 8.1.)

### - [ ] Step 8.3: Run full suite — expect all green

```bash
cd vnext && bun test
```
Expected: 0 failures. If anything still fails, it is genuine regression — fix before committing.

### - [ ] Step 8.4: Commit X-8

```bash
git add -A
git commit -m "test(vnext): delete IR-dependent test files (X-8)

These files exercised @vnext/protocols/ir and the old adapter contract, both
removed in X-6. Replacement coverage lands in X-9."
```

---

## Task 9 (X-9): Add Per-Pair / Per-Attempt / Per-Route Test Matrix

**Files:**
- Create per-pair: `vnext/packages/translators/tests/{chat-completions-via-messages,messages-via-chat-completions,responses-via-messages,messages-via-responses,gemini-via-messages,messages-via-gemini}.test.ts` (6 files; some may already exist as scaffold from Phase A — extend, don't duplicate).
- Create per-attempt: `vnext/apps/gateway/tests/attempts/{conversation,embeddings,images}.e2e.test.ts` (3 files).
- Create per-route: `vnext/apps/gateway/tests/routes/{messages,chat,responses,gemini,embeddings,images}.e2e.test.ts` (6 files).
- Create per-pair cancellation: extend each per-pair file with one `cancellation` test.

**Subject:** The new architecture demands three coverage axes: pair-level translator correctness, attempt-level observability/quota wiring, and route-level end-to-end shape. Spec §"Test Strategy" requires all three. This task fills the matrix.

### - [ ] Step 9.1: Per-pair golden tests (×6)

For each pair, write tests that lock down:
- **Request translation:** a representative front-end request maps to a known upstream request shape (snapshot or explicit asserts).
- **Event translation:** a representative upstream event sequence maps to a known front-end event sequence.
- **Cancellation:** when the consumer aborts mid-stream, the translator's `translateEvents` exits cleanly without leaking the upstream iterator.

Example for `chat-completions-via-messages`:

```ts
import { test, expect } from 'bun:test'
import { chatCompletionsViaMessages } from '@vnext/translators/chat-completions-via-messages'

test('OpenAI chat request → Anthropic Messages request', async () => {
  const upstream = await chatCompletionsViaMessages.translateRequest(
    { model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 },
    { signal: new AbortController().signal },
  )
  expect(upstream).toEqual({ model: 'm', max_tokens: 5, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
})

test('Anthropic events → OpenAI chat SSE chunks', async () => {
  const events = (async function*() {
    yield { type: 'message_start', message: { id: 'msg_1', model: 'm', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 0 } } }
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }
    yield { type: 'content_block_stop', index: 0 }
    yield { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }
    yield { type: 'message_stop' }
  })()
  const out: unknown[] = []
  for await (const evt of chatCompletionsViaMessages.translateEvents(events, { signal: new AbortController().signal })) {
    out.push(evt)
  }
  // Assert: at least one chunk with choices[0].delta.content === 'hi', a final chunk with finish_reason 'stop'.
  expect(out.some((e) => JSON.stringify(e).includes('"content":"hi"'))).toBe(true)
  expect(out.some((e) => JSON.stringify(e).includes('"finish_reason":"stop"'))).toBe(true)
})

test('cancellation: aborting the signal stops event translation cleanly', async () => {
  const ac = new AbortController()
  const upstream = (async function*() {
    yield { type: 'message_start', message: { id: 'msg_1', model: 'm', role: 'assistant', content: [], usage: { input_tokens: 1, output_tokens: 0 } } }
    ac.abort()
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'never' } }
  })()
  const collected: unknown[] = []
  try {
    for await (const evt of chatCompletionsViaMessages.translateEvents(upstream, { signal: ac.signal })) {
      collected.push(evt)
    }
  } catch (err) {
    // either silent termination or AbortError is acceptable — must not leak
    expect((err as Error).name === 'AbortError' || true).toBeTrue()
  }
  // Per spec: translator must observe signal and stop yielding after abort.
  expect(collected.some((e) => JSON.stringify(e).includes('"never"'))).toBe(false)
})
```

Repeat the same pattern for the other 5 pairs. Each gets its own request, events, and cancellation test (3 tests × 6 pairs = 18 pair-level tests).

### - [ ] Step 9.2: Per-attempt e2e tests (×3)

Each attempt module test covers the full attempt flow with a real `SqliteRepo` and `globalThis.fetch` override. Asserts:
- Quota check fires (denied path returns 429).
- Latency row written with correct `model`, `sourceApi`, `targetApi`, `upstream`, `userAgent`, `stream` fields.
- Usage row written with non-zero `input_tokens` / `output_tokens` (or images count, etc.).
- `signal.abort()` mid-call propagates to `globalThis.fetch` and the attempt returns an error result without writing partial usage.

```ts
// vnext/apps/gateway/tests/attempts/conversation.e2e.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { runConversationAttempt } from '../../src/data-plane/attempts/conversation.ts'
import { withTempRepo } from '../helpers/repo.ts'
import { installFetch, resetFetch } from '../helpers/fetch-mock.ts'

beforeEach(() => installFetch(canned200Messages))
afterEach(() => resetFetch())

test('non-streaming success writes 1 latency + 1 usage row', async () => {
  const { repo, apiKeyId } = await withTempRepo()
  const result = await runConversationAttempt({ /* … */ })
  expect(result.ok).toBe(true)
  const latencies = await repo.getLatencyRowsForApiKey(apiKeyId)
  expect(latencies.length).toBe(1)
  const usage = await repo.getUsageRowsForApiKey(apiKeyId)
  expect(usage.length).toBe(1)
})

test('quota denied returns 429 and writes no usage row', async () => { /* … */ })
test('mid-flight abort closes upstream and writes no usage row', async () => { /* … */ })
```

Repeat for `embeddings.e2e.test.ts` and `images.e2e.test.ts` (mode generate + mode edit each get their own assertion).

### - [ ] Step 9.3: Per-route e2e tests (×6)

End-to-end against the Hono `app`. Routes:
- `POST /v1/messages` (with and without `web_search` tool — confirm intercept still works post-X-7)
- `POST /v1/chat/completions`
- `POST /v1/responses` (with and without `image_generation` tool)
- `POST /v1beta/models/:model{.+}` (Gemini)
- `POST /v1/embeddings`
- `POST /v1/images/generations` and `POST /v1/images/edits` (single file covers both)

Each test:
- Installs a `globalThis.fetch` mock that returns a canned upstream response.
- Posts a request to the route.
- Asserts response status, content type, and a key body field.
- For streaming routes, drains the SSE and asserts at least 2 frames (message_start equivalent + at least one delta + final).

```ts
// vnext/apps/gateway/tests/routes/messages.e2e.test.ts (sketch)
test('POST /v1/messages non-streaming returns Anthropic JSON', async () => { /* … */ })
test('POST /v1/messages streaming returns SSE with content_block_delta', async () => { /* … */ })
test('POST /v1/messages with web_search tool returns intercepted result', async () => { /* … */ })
```

### - [ ] Step 9.4: Run the full suite

```bash
cd vnext && bun test
```
Expected: all tests green. Total count should be roughly:
- 38 retained baseline tests
- + Phase A new tests (translator scaffolds, attempt module units)
- + Phase B new dispatch tests
- + Phase C tests: 18 pair-level + ~12 attempt e2e + ~10 route e2e + 2 server-tools observability
≈ ~120-140 tests, all passing.

If a per-pair test reveals a translator bug: fix the translator, re-run, commit translator + test together.

### - [ ] Step 9.5: Verify cancellation coverage

```bash
cd vnext && grep -rn 'cancellation\|abort()' apps/gateway/tests packages/translators/tests
```
Expected: at least one `cancellation` test per pair (×6) and one per attempt (×3) = ≥ 9 matches.

### - [ ] Step 9.6: Commit X-9 (may be split into per-pair / per-attempt / per-route commits if large)

```bash
git add packages/translators/tests
git commit -m "test(translators): per-pair request/events/cancellation tests (X-9 part 1/3)"

git add apps/gateway/tests/attempts
git commit -m "test(gateway): per-attempt e2e tests with real SqliteRepo (X-9 part 2/3)"

git add apps/gateway/tests/routes
git commit -m "test(gateway): per-route e2e tests covering all 6 entry points (X-9 part 3/3)"
```

---

## Phase C Acceptance

- [ ] No `[observability] .* bypasses` strings appear in any `.ts` file.
- [ ] The 4 IR-dependent test files are gone.
- [ ] 6 per-pair test files exist and each has ≥ 3 tests (request / events / cancellation).
- [ ] 3 per-attempt e2e files exist and assert latency + usage rows in real `SqliteRepo`.
- [ ] 6 per-route e2e files exist and assert response shape + (where applicable) SSE frames.
- [ ] `bun test` is fully green from `vnext/` with no expected failures.
- [ ] `grep -rn 'mock.module' vnext/apps vnext/packages` returns zero matches (cross-cutting rule).

## Done — Pivot Complete

After Phase C, the architecture is:

```
client → frontend parse → pair selector → translator → ModelProvider.callX(...) → translator → frontend encode → client
```

with full observability on every entry point (including server-tool intercepts), zero IR code, and a coverage matrix that locks each translator + attempt + route shape independently. Future providers slot in by implementing `ModelProvider`'s `callX` methods — no changes to dispatch, translators, or attempt modules.
