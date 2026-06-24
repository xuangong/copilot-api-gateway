# Spec 10 Part 2 — Wire kitDeps in gateway + migrate chat-completions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the framework kit (`@vnext-gateway/chat-flow-kit`, built in Part 1) into the LLM gateway via a singleton `kitDeps`, then migrate `chat-completions/serve.ts` as the first endpoint adapter — proving the hook pattern end-to-end with the existing test suite untouched.

**Architecture:** Add `@vnext-llm/gateway` → `@vnext-gateway/chat-flow-kit` dependency. Build a single `kitDeps` adapter module in `chat-flow/shared/` that binds `runQuotaGate` / `jsonErrorWrap` / `buildTelemetryCtx` (with `TTelemetryCtx = TelemetryRequestContext`). Rewrite `chat-completions/serve.ts` to declare hooks + shape auth + call `serveTemplate`, deleting the inline parse/quota/controller/respond glue. All existing `serve.test.ts` cases must pass unchanged (same external behaviour).

**Tech Stack:** Bun + TypeScript strict, `verbatimModuleSyntax`, `allowImportingTsExtensions`. Test runner: `bun test` (workspace-wide; this part wires real dependencies and runs the full chat-completions integration suite).

---

## File Structure

- **Create:** `vnext/packages/gateway/src/data-plane/chat-flow/shared/kit-deps.ts` — builds the singleton `ServeTemplateDeps<TAuth, TelemetryRequestContext>` that all four endpoint wrappers will reuse. Binds the existing `runQuotaGate` / `jsonErrorWrap` / `getRuntimeLocation` plumbing. Sole authoritative construction site.
- **Create:** `vnext/packages/gateway/tests/data-plane/chat-flow/shared/kit-deps.test.ts` — TDD spec for `kitDeps`: telemetry ctx shape (`apiKeyId` fallback, `<unknown>` sentinel, `requestId` uuid default, `isStreaming` carry-through, `runtimeLocation` populated, `endpointTag` ignored by the deps but accepted in the signature), `runQuotaGate` passthrough, `jsonErrorWrap` passthrough.
- **Modify:** `vnext/packages/gateway/package.json` — add `"@vnext-gateway/chat-flow-kit": "workspace:*"` to `dependencies`.
- **Rewrite:** `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts` — hook declaration + `ChatCompletionsServeAuth = ChatCompletionsAttemptAuth & KitAuthCtx` intersection + auth shaping wrapper + single `serveTemplate(...)` call. Old parse/quota/controller/telemetry/respond glue is deleted.
- **Test (unchanged file, must still pass):** `vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/serve.test.ts` — the existing 2 cases (malformed JSON → 400; `stream:true` → no crash, status ∈ {400,404,502}) are the spec for "no observable behaviour change."

---

## Task 1: Wire `@vnext-gateway/chat-flow-kit` into `@vnext-llm/gateway`'s package graph

**Files:**
- Modify: `vnext/packages/gateway/package.json`

- [ ] **Step 1: Add the kit as a workspace dependency**

Insert the kit between the `@vnext-gateway/platform` and `@vnext-llm/protocols` entries (alphabetical within the `@vnext-gateway/*` group). After the change the `dependencies` block should contain:

```json
{
  "dependencies": {
    "@vnext-gateway/cache": "workspace:*",
    "@vnext-gateway/chat-flow-kit": "workspace:*",
    "@vnext-gateway/platform": "workspace:*",
    "@vnext-gateway/result": "workspace:*",
    "@vnext-gateway/service": "workspace:*",
    "@vnext-llm/protocols": "workspace:*",
    "@vnext-llm/provider-azure": "workspace:*",
    "@vnext-llm/provider-copilot": "workspace:*",
    "@vnext-llm/provider-custom": "workspace:*",
    "@vnext-llm/provider-llm": "workspace:*",
    "@vnext-llm/provider-sdf": "workspace:*",
    "@vnext-llm/responses-store": "workspace:*",
    "@vnext-llm/translate": "workspace:*",
    "hono": "^4.12.23",
    "image-size": "^2.0.2",
    "zod": "^4.4.3"
  }
}
```

Sort the `@vnext-gateway/*` keys alphabetically; do not reorder anything else. Leave `devDependencies` untouched.

- [ ] **Step 2: Refresh the lockfile**

Run: `cd vnext && bun install`
Expected: completes without errors, `bun.lock` gains a `@vnext-gateway/chat-flow-kit` workspace symlink. No version churn on unrelated packages.

- [ ] **Step 3: Verify gateway typecheck still passes BEFORE writing kit-deps**

Run: `cd vnext && bun --filter '@vnext-llm/gateway' run typecheck`
Expected: PASS. Adding the dep alone must not break anything — Task 1 is purely plumbing.

- [ ] **Step 4: Commit**

```bash
cd vnext
git add packages/gateway/package.json bun.lock
git commit -m "build(vnext/spec10): add @vnext-gateway/chat-flow-kit workspace dep to gateway

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

---

## Task 2: TDD `kitDeps` adapter — telemetry ctx shape

**Files:**
- Create: `vnext/packages/gateway/src/data-plane/chat-flow/shared/kit-deps.ts`
- Create: `vnext/packages/gateway/tests/data-plane/chat-flow/shared/kit-deps.test.ts`

This module is the **sole** authoritative construction site for `ServeTemplateDeps`. Every endpoint wrapper imports the same singleton (`kitDeps`). It binds:

| Kit field | Adapter implementation |
| --- | --- |
| `runQuotaGate` | re-export of `runQuotaGate` from `./quota-gate.ts` |
| `jsonErrorWrap` | re-export of `jsonErrorWrap` from `./error-wrap.ts` |
| `buildTelemetryCtx` | constructs `TelemetryRequestContext` exactly like the four serves do today |

Inline these directly inside `buildTelemetryCtx` — do not export it standalone, because the only consumer is `kitDeps`.

- [ ] **Step 1: Write the test scaffold**

Create the test file. Imports + helpers go in first; we'll add cases one at a time:

```ts
// vnext/packages/gateway/tests/data-plane/chat-flow/shared/kit-deps.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { __resetPlatformForTests } from '@vnext-gateway/platform'
import { setupTestPlatform } from '../../../_setup-platform.ts'
import type { KitAuthCtx, KitObsCtx } from '@vnext-gateway/chat-flow-kit'
import { kitDeps } from '../../../../src/data-plane/chat-flow/shared/kit-deps'

beforeAll(() => { setupTestPlatform() })
afterAll(() => { __resetPlatformForTests() })

type Auth = KitAuthCtx & { readonly userId?: string; readonly apiKeyId?: string | null }

function defaultObs(overrides: Partial<KitObsCtx> = {}): KitObsCtx {
  return { apiKeyId: 'k1', userAgent: 'ua', requestId: 'rid', ...overrides }
}
```

- [ ] **Step 2: Run the empty test file**

Run: `cd vnext && bun test packages/gateway/tests/data-plane/chat-flow/shared/kit-deps.test.ts`
Expected: FAIL with module-not-found on `'../../../../src/data-plane/chat-flow/shared/kit-deps'` (file doesn't exist yet).

- [ ] **Step 3: Add the first failing test — `buildTelemetryCtx` populates all fields from obsCtx + auth + flags**

Append to the test file:

```ts
test('buildTelemetryCtx copies apiKeyId/userAgent/requestId from obsCtx, threads isStreaming + requestStartedAt, populates runtimeLocation', () => {
  const startedAt = Date.now()
  const ctx = kitDeps.buildTelemetryCtx({
    auth: { apiKeyId: 'auth-key' } as Auth,
    obsCtx: defaultObs(),
    isStreaming: true,
    requestStartedAt: startedAt,
    endpointTag: 'chat_completions',
  })
  expect(ctx.apiKeyId).toBe('k1')
  expect(ctx.userAgent).toBe('ua')
  expect(ctx.requestId).toBe('rid')
  expect(ctx.isStreaming).toBe(true)
  expect(ctx.requestStartedAt).toBe(startedAt)
  expect(ctx.runtimeLocation).toBeDefined()
  expect(typeof ctx.runtimeLocation).toBe('object')
})
```

- [ ] **Step 4: Run the test — expect failure**

Run: `cd vnext && bun test packages/gateway/tests/data-plane/chat-flow/shared/kit-deps.test.ts`
Expected: FAIL (module still missing).

- [ ] **Step 5: Write minimal `kit-deps.ts` to pass the first test**

Create the source file:

```ts
// vnext/packages/gateway/src/data-plane/chat-flow/shared/kit-deps.ts
/**
 * Singleton ServeTemplateDeps for the LLM gateway's four chat-flow endpoints.
 *
 * The kit (@vnext-gateway/chat-flow-kit) is domain-neutral and takes its
 * env-touching collaborators by injection. This module is the SOLE
 * authoritative construction site — every endpoint wrapper imports the same
 * `kitDeps` value, so we never accidentally diverge on how the telemetry ctx
 * is shaped, how quota is enforced, or how 4xx envelopes are wrapped.
 *
 * `buildTelemetryCtx` mirrors what the four serves did inline before Spec 10:
 *   - apiKeyId falls back from obsCtx → auth.apiKeyId → '<unknown>' sentinel
 *     (anonymous test traffic);
 *   - requestId defaults to `crypto.randomUUID()` when the inbound header is
 *     absent (matches DispatchObsCtx tolerance);
 *   - userAgent stays nullable to match TelemetryRequestContext;
 *   - runtimeLocation is captured once via getRuntimeLocation() so persistence
 *     helpers tag rows with the right region/runtime.
 *
 * Reference: Spec 10 §3.2.
 */
import { getRuntimeLocation } from '@vnext-gateway/platform'
import type { KitAuthCtx, ServeTemplateDeps } from '@vnext-gateway/chat-flow-kit'
import { jsonErrorWrap } from './error-wrap.ts'
import { runQuotaGate } from './quota-gate.ts'
import type { TelemetryRequestContext } from './telemetry-ctx.ts'

type AuthWithApiKey = KitAuthCtx & { readonly apiKeyId?: string | null }

export const kitDeps: ServeTemplateDeps<AuthWithApiKey, TelemetryRequestContext> = {
  runQuotaGate,
  jsonErrorWrap,
  buildTelemetryCtx: ({ auth, obsCtx, isStreaming, requestStartedAt }) => ({
    apiKeyId: (obsCtx.apiKeyId as string | null | undefined) ?? auth.apiKeyId ?? '<unknown>',
    userAgent: (obsCtx.userAgent as string | null | undefined) ?? null,
    requestId: (obsCtx.requestId as string | undefined) ?? crypto.randomUUID(),
    isStreaming,
    runtimeLocation: getRuntimeLocation(),
    requestStartedAt,
  }),
}
```

- [ ] **Step 6: Run the test — expect pass**

Run: `cd vnext && bun test packages/gateway/tests/data-plane/chat-flow/shared/kit-deps.test.ts`
Expected: PASS (1/1).

- [ ] **Step 7: Add fallback tests — `apiKeyId` and `requestId` defaulting**

Append:

```ts
test('buildTelemetryCtx falls back to auth.apiKeyId when obsCtx.apiKeyId is missing', () => {
  const ctx = kitDeps.buildTelemetryCtx({
    auth: { apiKeyId: 'auth-key' } as Auth,
    obsCtx: defaultObs({ apiKeyId: null }),
    isStreaming: false,
    requestStartedAt: 1,
    endpointTag: 't',
  })
  expect(ctx.apiKeyId).toBe('auth-key')
})

test('buildTelemetryCtx falls back to <unknown> when neither obsCtx.apiKeyId nor auth.apiKeyId present', () => {
  const ctx = kitDeps.buildTelemetryCtx({
    auth: {} as Auth,
    obsCtx: defaultObs({ apiKeyId: null }),
    isStreaming: false,
    requestStartedAt: 1,
    endpointTag: 't',
  })
  expect(ctx.apiKeyId).toBe('<unknown>')
})

test('buildTelemetryCtx generates a uuid for requestId when obsCtx.requestId is undefined', () => {
  const ctx = kitDeps.buildTelemetryCtx({
    auth: {} as Auth,
    obsCtx: defaultObs({ requestId: undefined }),
    isStreaming: false,
    requestStartedAt: 1,
    endpointTag: 't',
  })
  expect(ctx.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
})

test('buildTelemetryCtx defaults userAgent to null when obsCtx.userAgent is missing', () => {
  const ctx = kitDeps.buildTelemetryCtx({
    auth: {} as Auth,
    obsCtx: defaultObs({ userAgent: null }),
    isStreaming: false,
    requestStartedAt: 1,
    endpointTag: 't',
  })
  expect(ctx.userAgent).toBeNull()
})
```

- [ ] **Step 8: Run the suite — expect 5 passing**

Run: `cd vnext && bun test packages/gateway/tests/data-plane/chat-flow/shared/kit-deps.test.ts`
Expected: PASS (5/5).

- [ ] **Step 9: Add a quota gate passthrough test**

Append:

```ts
test('runQuotaGate returns null for anonymous (apiKeyId nullish) — wired through', async () => {
  const resp = await kitDeps.runQuotaGate(null)
  expect(resp).toBeNull()
})
```

`runQuotaGate(null)` is the only quota path we can assert deterministically without a stub repo — it short-circuits before `checkQuota`. The over-cap branch is covered by the existing `quota-gate` tests; here we only need to prove the binding is live.

- [ ] **Step 10: Add a `jsonErrorWrap` passthrough test**

Append:

```ts
test('jsonErrorWrap returns a JSON Response with the given status and body — wired through', async () => {
  const resp = kitDeps.jsonErrorWrap(418, { error: { type: 'teapot', message: 'short and stout' } })
  expect(resp.status).toBe(418)
  expect(resp.headers.get('content-type')).toBe('application/json')
  expect(await resp.json()).toEqual({ error: { type: 'teapot', message: 'short and stout' } })
})
```

- [ ] **Step 11: Run the suite — expect 7 passing**

Run: `cd vnext && bun test packages/gateway/tests/data-plane/chat-flow/shared/kit-deps.test.ts`
Expected: PASS (7/7).

- [ ] **Step 12: Run framework purity gate (kit dep direction)**

Run: `cd vnext && bun run check:framework-purity`
Expected: PASS. `kit-deps.ts` lives in `@vnext-llm/gateway`, so importing the kit is the correct direction; the gate only flags reverse imports.

- [ ] **Step 13: Commit**

```bash
cd vnext
git add packages/gateway/src/data-plane/chat-flow/shared/kit-deps.ts \
        packages/gateway/tests/data-plane/chat-flow/shared/kit-deps.test.ts
git commit -m "feat(vnext/spec10): add kitDeps singleton adapter for chat-flow endpoints

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

---

## Task 3: Migrate `chat-completions/serve.ts` to call `serveTemplate`

The rewrite goal: same observable behaviour, zero changes to `attempt.ts`, `respond.ts`, `http.ts`, the existing `serve.test.ts`, or any integration test. Only `serve.ts` changes.

**Files:**
- Modify (rewrite): `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts`
- Verify (unchanged): `vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/serve.test.ts`

- [ ] **Step 1: Baseline — run the existing serve.test.ts to confirm it passes BEFORE rewrite**

Run: `cd vnext && bun test packages/gateway/tests/data-plane/chat-flow/chat-completions/serve.test.ts`
Expected: PASS (2/2). This is the green baseline we must preserve.

- [ ] **Step 2: Replace `serve.ts` with the hook-declaration shape**

Overwrite the file in full:

```ts
// vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts
/**
 * Chat Completions HTTP serve layer (Spec 10 — chat-flow convergence).
 *
 * Migrated to the framework kit (@vnext-gateway/chat-flow-kit). The old
 * inline parse → telemetry → quota → AbortController → attempt → respond
 * chain now lives behind `serveTemplate(...)`; this file only declares the
 * endpoint-specific hooks and shapes the inbound DataPlaneAuthCtx into the
 * intersection auth type the kit needs.
 *
 * Why the intersection? `ChatCompletionsAttemptAuth` (= SelectBindingAuth)
 * has `{ownerId?, pin?, copilot?}` but no `apiKeyId`. The kit requires
 * `TAuth extends KitAuthCtx` (which contributes `apiKeyId`) so it can run
 * quota and tag telemetry. We intersect the two locally so the existing
 * attempt-auth type stays untouched; structural typing means the extra
 * `apiKeyId` field is silently ignored when `runAttempt` forwards `auth`
 * down to `chatCompletionsAttempt.generate`.
 *
 * Reference: Spec 10 §3.4.
 */
import { serveTemplate, type KitAuthCtx, type ServeTemplateHooks } from '@vnext-gateway/chat-flow-kit'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseChatPayload } from '../../parsers.ts'
import { kitDeps } from '../shared/kit-deps.ts'
import type { DispatchObsCtx } from '../shared/gateway-ctx.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import { chatCompletionsAttempt, type ChatCompletionsAttemptAuth, type ChatCompletionsAttemptResult } from './attempt.ts'
import { respondChatCompletions } from './respond.ts'

export interface ChatCompletionsServeArgs {
  /** Pre-parsed JSON body from http.ts (`await c.req.json()`). */
  readonly raw: unknown
  readonly auth: DataPlaneAuthCtx
  readonly obsCtx: DispatchObsCtx
  /**
   * Optional client-side abort signal (Hono's `c.req.raw.signal`). When the
   * client disconnects we propagate the abort down to provider.fetch via a
   * controller the kit links internally.
   */
  readonly signal?: AbortSignal
}

type ChatCompletionsPayload = Record<string, unknown> & {
  model: string
  stream?: boolean
  stream_options?: { include_usage?: boolean }
}

/**
 * Wrapper-local intersection auth. See module header for why this is
 * necessary — the kit needs apiKeyId for quota, attempt does not.
 */
type ChatCompletionsServeAuth = ChatCompletionsAttemptAuth & KitAuthCtx

const chatCompletionsHooks: ServeTemplateHooks<
  ChatCompletionsPayload,
  ChatCompletionsAttemptResult,
  undefined,
  ChatCompletionsServeAuth,
  TelemetryRequestContext
> = {
  endpointTag: 'chat_completions',

  parse: ({ raw }) => {
    try {
      return parseChatPayload(raw) as ChatCompletionsPayload
    } catch (err) {
      // Re-throw with the {status, body} shape kitDeps.jsonErrorWrap consumes.
      // parseChatPayload already attaches both, but it also throws plain
      // SyntaxError for malformed JSON which we need to wrap into the same
      // legacy envelope clients expect.
      const e = err as Error & { status?: number; body?: unknown }
      const wrapped = new Error(e.message) as Error & { status?: number; body?: unknown }
      wrapped.status = e.status ?? 400
      wrapped.body = e.body ?? {
        error: { type: 'invalid_request_error', message: e.message },
      }
      throw wrapped
    }
  },

  wantsStream: (p) => p.stream === true,

  runAttempt: (a) => chatCompletionsAttempt.generate({
    payload: a.payload,
    // Structural typing: extra apiKeyId on auth is ignored by attempt.
    auth: a.auth,
    ctx: { requestStartedAt: a.requestStartedAt, downstreamAbortSignal: a.downstreamAbortSignal },
    telemetryCtx: a.telemetryCtx,
  }),

  respond: (r, c) => respondChatCompletions(r, {
    wantsStream: c.wantsStream,
    includeUsageChunk: c.payload.stream_options?.include_usage === true,
    downstreamAbortController: c.downstreamAbortController,
    telemetryCtx: c.telemetryCtx,
  }),
}

export async function serveChatCompletions(args: ChatCompletionsServeArgs): Promise<Response> {
  const auth: ChatCompletionsServeAuth = {
    ownerId: args.auth.userId,
    copilot: args.auth.copilot,
    apiKeyId: args.auth.apiKeyId,
  }
  const { response } = await serveTemplate(
    chatCompletionsHooks,
    { raw: args.raw, auth, obsCtx: args.obsCtx, signal: args.signal, extras: {} },
    kitDeps,
  )
  return response
}
```

- [ ] **Step 3: Run the existing serve.test.ts — expect both cases still PASS**

Run: `cd vnext && bun test packages/gateway/tests/data-plane/chat-flow/chat-completions/serve.test.ts`
Expected: PASS (2/2). This is the spec-compliance gate for "no observable behaviour change."

- [ ] **Step 4: Typecheck the gateway package**

Run: `cd vnext && bun --filter '@vnext-llm/gateway' run typecheck`
Expected: PASS. The intersection type and structural-typing forwarding to `chatCompletionsAttempt.generate` must compile cleanly.

- [ ] **Step 5: Run the full chat-completions test directory**

Run: `cd vnext && bun test packages/gateway/tests/data-plane/chat-flow/chat-completions/`
Expected: PASS — all cases (attempt, respond, integration if present) still green. We didn't touch attempt/respond, but this validates that `serveChatCompletions`'s callers see the same Response shape.

- [ ] **Step 6: Run the full gateway suite**

Run: `cd vnext && bun test packages/gateway`
Expected: PASS. The wider blast radius (http.ts → serveChatCompletions consumers, integration tests, server tool tests) must remain green.

- [ ] **Step 7: Commit**

```bash
cd vnext
git add packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts
git commit -m "refactor(vnext/spec10): migrate chat-completions serve to chat-flow-kit

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

---

## Task 4: Acceptance gates for Part 2

These are subset gates of the spec's full A1-A7. Parts 3 & 4 will re-run them after migrating the remaining three endpoints.

**Files:**
- Verify (no edits): all files touched in Tasks 1-3.

- [ ] **Step 1: A1 subset — full workspace test pass**

Run: `cd vnext && bun run test`
Expected: PASS. The `test` script runs framework-purity check first, then `bun test` workspace-wide. Migrating one endpoint must not break the other three.

- [ ] **Step 2: A2 subset — kit + gateway typecheck**

Run: `cd vnext && bun --filter '@vnext-gateway/chat-flow-kit' run typecheck && bun --filter '@vnext-llm/gateway' run typecheck`
Expected: PASS for both packages.

- [ ] **Step 3: A3 subset — framework purity gate**

Run: `cd vnext && bun run check:framework-purity`
Expected: PASS. `kit-deps.ts` and the new `serve.ts` both import from the kit (correct direction); neither leaks LLM literals into kit src.

- [ ] **Step 4: A4 line count reference (informational, not a hard gate)**

Run: `cd vnext && wc -l packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts`
Expected: noticeably smaller than the pre-Spec-10 `~115`. The spec target for chat-completions is "well under 60." Don't fail the task if it's 65 — A4 is goal-based, not a hard count. The boilerplate (parse-catch, telemetry construction, quota call, controller linking, attempt invocation, respond call) is what must be gone; auth shaping + hook declaration may push the file slightly higher.

- [ ] **Step 5: Manual diff review — what shrank**

Run: `cd vnext && git show HEAD:packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts | wc -l && git show HEAD~1:packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts 2>/dev/null | wc -l`
Expected: the second value (pre-migration) is the ~115-line baseline; the first should be smaller. Eyeball the diff: confirm the controller-linking block, `telemetryCtx` construction, `runQuotaGate` call, and the `chatCompletionsAttempt.generate(...)` + `respondChatCompletions(...)` glue are gone (now inside `serveTemplate` / `kitDeps` / hooks).

---

## Self-Review

### Spec coverage

| Spec §/Acceptance | Where in this plan |
| --- | --- |
| §3.2 `ServeTemplateDeps` injection | Task 2 — `kitDeps` is the singleton |
| §3.2 `buildTelemetryCtx` semantics (apiKeyId fallback, requestId default, runtimeLocation) | Task 2 Steps 3, 7 |
| §3.2 `runQuotaGate` / `jsonErrorWrap` injection | Task 2 Steps 9, 10 |
| §3.4 chat-completions adapter shape | Task 3 Step 2 (full rewrite) |
| §3.4 intersection auth pattern (`ChatCompletionsServeAuth = AttemptAuth & KitAuthCtx`) | Task 3 Step 2 |
| §3.4 auth shaping happens in wrapper, not in kit | Task 3 Step 2 — `serveChatCompletions` body |
| A1 (`bun test` still passes) | Task 3 Steps 3, 5, 6; Task 4 Step 1 |
| A2 (kit + gateway typecheck) | Task 4 Step 2 |
| A3 (framework purity gate) | Task 2 Step 12; Task 4 Step 3 |
| A4 (serve.ts shrinks to a thin wrapper) | Task 4 Steps 4, 5 |
| A5 (kit-level unit suite) | covered in Part 1 — not re-tested here |
| A6 (Docker `--no-cache` build) | deferred to Part 4 (after all endpoints migrate, single Dockerfile edit) |
| A7 (live smoke) | deferred to deploy window |

Out-of-scope for Part 2 (handled later): messages / responses / gemini serve migrations (Parts 3 & 4), Dockerfile COPY list update (Part 4), live smoke (deploy window).

### Placeholder scan

- No TBD/TODO/"fill in later" markers.
- Every code step contains the full code to write.
- Test bodies are concrete with deterministic assertions.
- Commands include their expected outcome.

### Type consistency

- `ChatCompletionsServeAuth` (Task 3) intersects `ChatCompletionsAttemptAuth` (defined in `attempt.ts`, re-exported in Step 2's imports) with `KitAuthCtx` (from the kit). Both type names are stable and used consistently.
- `kitDeps`'s `AuthWithApiKey` type (Task 2 Step 5) is structurally a subset of `ChatCompletionsServeAuth` — the kit only reads `apiKeyId` for quota, so a broader auth-shape from the wrapper is fine. (Generic variance: `ServeTemplateDeps<TAuth, ...>` is contravariant in `TAuth` for `buildTelemetryCtx`'s `auth` field, but we pass the singleton through `serveTemplate<..., TAuth=ChatCompletionsServeAuth, ...>` which requires `ChatCompletionsServeAuth` to extend `AuthWithApiKey` — it does, since both extend `KitAuthCtx`.)
- `TelemetryRequestContext` flows through `kitDeps.buildTelemetryCtx` return type → `ServeTemplateHooks<..., TTelemetryCtx>` generic → `runAttempt`/`respond` ctx — same type, same name, end-to-end.
- `ChatCompletionsAttemptResult` (re-exported in Step 2) is the `TAttemptResult` generic — same name as in Part 1's test types (`AttemptResult` was the placeholder; here it's the real type).

### Edge cases worth flagging for the implementer

- **`parseChatPayload` throw shape:** the existing serve catches any `Error` (including malformed-JSON `SyntaxError`) and wraps `{status, body}` defensively. The new hook's `parse` does the same throw-and-wrap pattern so the kit's parse-error fallback (calling `jsonErrorWrap(status, body)`) renders the identical envelope.
- **`requestStartedAt` source:** in the old serve, `requestStartedAt` was captured once before telemetry ctx and reused in attempt's `ctx`. In the kit, `requestStartedAt` is captured by `serveTemplate` (between `wantsStream` and `buildTelemetryCtx`) and threaded through `RunAttemptArgs.requestStartedAt`. The hook passes that value into the attempt's `ctx`. Net effect is the same — one timestamp per request, threaded everywhere.
- **`attempt.ts` accepts an auth object with an extra `apiKeyId` field:** TypeScript structural typing makes this safe — the function signature reads only the fields it declares (`ownerId`, `pin`, `copilot`). No `as any` cast is needed in `runAttempt`.
