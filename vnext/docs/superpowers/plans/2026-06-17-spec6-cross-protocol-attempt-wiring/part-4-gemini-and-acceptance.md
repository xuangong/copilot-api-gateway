# Spec 6 — Part 4: gemini refactor + integration battery + SDK regression

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan part-by-part.

**Goal:** Refactor `gemini/attempt.ts` to use the same `traverseTranslation` helper instead of its bespoke `parseHubStream → unwrapHubFrames → translator.translateEvents` path. Run the full §6.2 integration battery, run §6.3 SDK regression, validate §6.4 static gates.

**Depends on:** Parts 1, 2, 3 complete.

**Architecture:** Gemini has no native hub (no `gemini` upstream exists in the binding table). Today `gemini/attempt.ts` already runs cross-protocol always; it just does so via custom code. Spec 6 unifies that path through `traverseTranslation` so telemetry stamping and `translateBody` propagation match the other three attempts. This part also deletes now-redundant local helpers: `parseHubStream`, `synthesizeHubFramesFromJson`, `targetToHubProtocol`, `unwrapHubFrames`.

**Tech Stack:** TypeScript, Bun.

---

## Task 1: gemini — refactor to `traverseTranslation`

**Spec ref:** §3.4 (gemini paragraph), §5 (gemini file changes)

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/gemini/attempt.ts`
- Modify (test): `vnext/packages/gateway/src/data-plane/chat-flow/gemini/attempt.test.ts`

- [ ] **Step 1: Write failing tests** that confirm:
  1. `result.modelIdentity.translatorPair = { source: 'gemini', hub: <whatever> }` is stamped (today the gemini path doesn't add this).
  2. `result.translateBody` is set to `sel.translator.translateBody` (today it's not).
  3. The streaming path still produces gemini-shaped frames.

- [ ] **Step 2: Replace the bespoke cross-protocol path** in `gemini/attempt.ts` with a `traverseTranslation` call.

```ts
// Replace the existing `parseHubStream → unwrapHubFrames → translator.translateEvents`
// block with:
return await traverseTranslation({
  sourcePayload: args.payload as Record<string, unknown>,
  sourceProtocol: 'gemini',
  hubProtocol: sel.targetEndpoint,
  translator: sel.translator,
  innerAttempt: async (innerArgs) => {
    const hubAttempt = pickHubAttempt(sel.targetEndpoint as HubAttemptProtocol)
    return (await hubAttempt.generate({
      payload: innerArgs.payload as never,
      auth: innerArgs.auth as never,
      ctx: { downstreamAbortSignal: innerArgs.signal } as never,
      telemetryCtx: innerArgs.inheritedTelemetryCtx,
      inheritedHeaders: innerArgs.inheritedHeaders,
      snapshotMode: innerArgs.snapshotMode,
    } as never)) as never
  },
  inheritedHeaders: args.inheritedHeaders ?? {},
  inheritedTelemetryCtx: args.telemetryCtx,
  auth: args.auth,
  signal: args.ctx.downstreamAbortSignal,
  fallbackMaxOutputTokens: (sel.binding as { upstreamMaxOutputTokens?: number }).upstreamMaxOutputTokens,
  model: args.model,  // gemini-specific: model comes from URL path, not payload
})
```

Add imports:

```ts
import { traverseTranslation } from '../shared/traverse-translation.ts'
import { pickHubAttempt, type HubAttemptProtocol } from '../shared/hub-attempt-dispatch.ts'
```

- [ ] **Step 3: Delete redundant local helpers** from `gemini/attempt.ts`:
  - `parseHubStream`
  - `synthesizeHubFramesFromJson`
  - `targetToHubProtocol`
  - `unwrapHubFrames`

These are now subsumed by the hub attempt's own terminal (which does its own parse/synthesize) and the helper's `translator.translateEvents` wrapping.

- [ ] **Step 4: Run** all gemini tests + typecheck

```bash
bun test vnext/packages/gateway/src/data-plane/chat-flow/gemini/
bun typecheck
```

Expected: PASS. Streaming gemini requests still produce gemini-shaped events. Telemetry now carries `translatorPair`.

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/gemini/attempt.ts vnext/packages/gateway/src/data-plane/chat-flow/gemini/attempt.test.ts
git commit -m "refactor(gateway/gemini): unify cross-protocol path through traverseTranslation"
```

---

## Task 2: gemini — respond.ts translateBody (non-streaming)

**Spec ref:** §3.7

**Files:**
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/gemini/respond.ts`
- Modify: `vnext/packages/gateway/src/data-plane/chat-flow/gemini/events/reassemble.ts`
- Test: `vnext/packages/gateway/src/data-plane/chat-flow/gemini/respond.test.ts`

Note: gemini non-streaming is `generateContent` (not `streamGenerateContent`). Today the response is reassembled from translated events. With `translateBody` set, we can skip the event reassembly and call `translator.translateBody(hubJson)` directly.

- [ ] **Step 1: Write failing test** (gemini non-streaming with `translateBody` set produces gemini-shaped JSON via direct hub-JSON → gemini-JSON mapping).

- [ ] **Step 2: Edit `gemini/respond.ts`** non-streaming branch (mirror Part 2 Task 4 pattern, default `hubProtocol = result.modelIdentity.translatorPair?.hub ?? 'chat_completions'` — gemini has no native hub).

- [ ] **Step 3: Edit `gemini/events/reassemble.ts`** to accept optional `hubProtocol`. For gemini, the supported hubs are all of `chat_completions | messages | responses`.

- [ ] **Step 4: Run** tests, commit.

```bash
git add vnext/packages/gateway/src/data-plane/chat-flow/gemini/
git commit -m "feat(gateway/gemini): respond.ts uses translateBody for non-streaming"
```

---

## Task 3: chat-completions, messages, responses — re-verify respond.ts after gemini refactor

**Spec ref:** §3.7

**Files:**
- (read-only verification)

The four `respond.ts` files now share the same `translateBody` pattern. Run a quick consistency audit:

- [ ] **Step 1: For each of the four respond.ts files**, confirm the non-streaming branch follows the same pattern:
  ```ts
  const hubProtocol = result.modelIdentity.translatorPair?.hub ?? <ownProtocol>
  const reassembled = await reassembleEventsToJson(result.events, hubProtocol)
  const finalJson = result.translateBody ? await result.translateBody(reassembled, ctx) : reassembled
  ```

- [ ] **Step 2: If any drift exists**, fix inline.

- [ ] **Step 3: Commit any consistency fixes** (skip if none).

---

## Task 4: Full §6.2 integration battery

**Spec ref:** §6.2 (4 endpoints × 2 stream modes = 8 cases)

**Files:**
- Create: `vnext/tests/integration/cross-protocol/gemini-to-other.test.ts`
- (Other 6 cases already created in Parts 2 & 3)

- [ ] **Step 1: Write `gemini-to-other.test.ts`** — gemini source against both a `chat_completions`-upstream and a `responses`-upstream model, both stream modes.

```ts
import { test, expect } from 'bun:test'

const BASE = process.env.TEST_API_BASE_URL ?? 'http://localhost:8787'
const KEY = process.env.TEST_API_KEY ?? 'test-key'

test('gemini → cc non-streaming generateContent', async () => {
  const res = await fetch(`${BASE}/v1beta/models/gpt-4.1:generateContent?key=${KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }),
  })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.candidates?.[0]?.content).toBeDefined()
})

test('gemini → cc streamGenerateContent', async () => {
  const res = await fetch(`${BASE}/v1beta/models/gpt-4.1:streamGenerateContent?key=${KEY}&alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    }),
  })
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text).toContain('data:')
})

// Repeat for gpt-5.4-mini (responses upstream)
```

- [ ] **Step 2: Run the full battery** (`bun run local` in another terminal).

```bash
bun test vnext/tests/integration/cross-protocol/
```

Expected: ALL 8 cases pass.

- [ ] **Step 3: Commit**

```bash
git add vnext/tests/integration/cross-protocol/gemini-to-other.test.ts
git commit -m "test(integration): gemini cross-protocol cases (final battery, 8/8)"
```

---

## Task 5: Audit translator pairs for `translateEvents` + `translateBody` completeness

**Spec ref:** §8 (open risks)

**Files:**
- Read-only audit of: `vnext/packages/translate/src/<10 pairs>/{events,body}.ts`

- [ ] **Step 1: For each of the 10 pairs**, confirm:
  1. `events.ts` exports a `translateEvents` that handles all source frame kinds without throwing on unknown.
  2. `body.ts` exports a `translateBody` that produces a complete source-shaped JSON envelope from a hub-shaped JSON.

- [ ] **Step 2: For any pair with a stub** (e.g., `body.ts` returns `{}` or throws "not implemented"), file it as a follow-up issue (don't block Spec 6 unless §6.2 integration fails because of it).

- [ ] **Step 3: Document the audit result** in a 10-line comment block at the top of `traverse-translation.ts` referencing pair status (or write a `vnext/docs/superpowers/notes/2026-06-17-spec6-translator-audit.md`).

- [ ] **Step 4: Commit any docs**

```bash
git add vnext/docs/superpowers/notes/
git commit -m "docs(spec6): translator pair audit notes"
```

---

## Task 6: SDK regression

**Spec ref:** §6.3

- [ ] **Step 1: Capture pre-Spec-3 baseline** (or use the Spec 3 closing baseline reported in Task notes).

- [ ] **Step 2: Run** all three SDK integration suites:

```bash
bun run test:integration:anthropic
bun run test:integration:openai
bun run test:integration:gemini
```

- [ ] **Step 3: Compare to baseline.** Acceptance gate: **no new failures**. New passes are fine.

- [ ] **Step 4: If any new failure**, triage:
  - Is it a regression in cross-protocol routing? → fix the failing pair's `translateEvents` / `translateBody`.
  - Is it a flaky test? → re-run; if still flaky, document and accept.
  - Is it pre-existing? → out-of-scope for this spec.

- [ ] **Step 5: Document SDK results** in the part-4 commit message.

```bash
git commit --allow-empty -m "test: spec-6 SDK regression baseline OK (anthropic/openai/gemini parity)"
```

---

## Task 7: Static gates

**Spec ref:** §6.4

- [ ] **Step 1: Run typecheck**

```bash
bun typecheck
```

Expected: PASS.

- [ ] **Step 2: Run static grep**

```bash
grep -rn 'cross-protocol attempts not yet supported' vnext/packages/
```

Expected: ZERO lines.

- [ ] **Step 3: Run unit tests across all touched packages**

```bash
bun test vnext/packages/protocols/ vnext/packages/translate/ vnext/packages/gateway/
```

Expected: ALL green.

- [ ] **Step 4: If any gate fails**, fix and re-run; do not proceed until all four green.

---

## Part 4 exit gate (and overall Spec 6 acceptance)

- [ ] §6.1 — unit tests for `traverseTranslation` (7 cases), per-attempt cross tests, errors test, request-test audits, respond.test updates: ALL green
- [ ] §6.2 — 8/8 integration cases green
- [ ] §6.3 — SDK regression: no new failures
- [ ] §6.4 — `bun typecheck` clean; `grep` returns 0 lines for the 501 sentinel
- [ ] §6.5 — production validation deferred to manual QA after Part 4 lands (out-of-plan)

After all gates green:
- Run `superpowers:finishing-a-development-branch` skill to choose merge / PR / discard.
- Note: §6.5 production validation requires Docker rebuild + deploy to `gateway.xianliao.de5.net`; verify `gpt-5.4-mini` via `/v1/chat/completions` returns 200, and `gpt-4.1` via `/v1/responses` returns 200.
