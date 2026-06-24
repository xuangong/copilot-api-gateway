# Spec 10 Part 3 — Migrate messages + gemini serves to chat-flow-kit

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the second and third endpoint wrappers — `messages/serve.ts` and `gemini/serve.ts` — to declare hooks + call `serveTemplate(...)` against the singleton `kitDeps` landed in Part 2. After this part, three of four endpoints are converged; only `responses` remains (Part 4) because of its `preProcess` short-circuit branch.

**Architecture:** Same intersection-auth + hook-declaration pattern as Part 2's chat-completions. Each serve becomes a thin wrapper: `<Endpoint>ServeAuth = <Endpoint>AttemptAuth & KitAuthCtx`, hook object declares `endpointTag` / `parse` / `wantsStream` / `runAttempt` / `respond`, and the exported function shapes `DataPlaneAuthCtx → ServeAuth` then issues a single `serveTemplate(...)` call. Gemini is the more nuanced case because it routes `model` + `forceStream` through `input.extras` and uses `extras.forceStream` (not `payload.stream`) inside `wantsStream`.

**Tech Stack:** Bun + TypeScript strict, `verbatimModuleSyntax`. Test runner: `bun test`.

---

## File Structure

- **Rewrite:** `vnext/packages/gateway/src/data-plane/chat-flow/messages/serve.ts` — hook declaration + intersection auth + single `serveTemplate` call. Old inline parse / quota / controller / telemetry / respond glue deleted.
- **Rewrite:** `vnext/packages/gateway/src/data-plane/chat-flow/gemini/serve.ts` — same shape, but extras carries `{ model, forceStream }` and `wantsStream` reads `extras.forceStream`. `runAttempt` reads `extras.model` / `extras.forceStream` back out and forwards to `geminiAttempt.generate`.

- **Modify (export only):** `vnext/packages/gateway/src/data-plane/chat-flow/messages/attempt.ts` — add `export type` for `MessagesAttemptResult` if not already exported externally (verify in Task 1 Step 1; the type exists at line 57 — confirm it's exported, otherwise no-op).

- **Test (unchanged files, must still pass):**
  - `vnext/packages/gateway/tests/data-plane/chat-flow/messages/attempt*.test.ts` + `respond*.test.ts` (if any) + integration suites that exercise `serveMessages`
  - `vnext/packages/gateway/tests/data-plane/chat-flow/gemini/*.test.ts` (attempt, respond, state-bridge, reshape-count) + integration suites exercising `serveGemini`
  - Neither endpoint has a dedicated `serve.test.ts`. The behaviour-preservation gate is the **workspace-wide `bun test`** plus any `apps/platform-bun` HTTP integration tests that round-trip through these serves.

---

## Task 1: Migrate `messages/serve.ts`

**Files:**
- Modify (rewrite): `vnext/packages/gateway/src/data-plane/chat-flow/messages/serve.ts`

- [ ] **Step 1: Verify `MessagesAttemptResult` is exported from `attempt.ts`**

Run: `cd vnext && grep -E "^export (type|interface) (MessagesAttemptResult|MessagesAttemptAuth)" packages/gateway/src/data-plane/chat-flow/messages/attempt.ts`
Expected: two matches — both types already exported. If `MessagesAttemptResult` is NOT prefixed with `export`, edit `attempt.ts` line 57 to add `export` and commit separately before continuing. (Per Part 2's grep at plan-write time, line 57 reads `export type MessagesAttemptResult = …`, so this should be a no-op.)

- [ ] **Step 2: Baseline — run the messages test directory to confirm the current suite is green**

Run: `cd vnext && bun test packages/gateway/tests/data-plane/chat-flow/messages/`
Expected: PASS. This is our green baseline; the migration must keep it green.

- [ ] **Step 3: Rewrite `messages/serve.ts` to the hook-declaration shape**

Overwrite the file in full:

```ts
// vnext/packages/gateway/src/data-plane/chat-flow/messages/serve.ts
/**
 * Anthropic Messages HTTP serve layer (Spec 10 — chat-flow convergence).
 *
 * Migrated to the framework kit (@vnext-gateway/chat-flow-kit). The old
 * inline parse → telemetry → quota → AbortController → attempt → respond
 * chain now lives behind `serveTemplate(...)`; this file only declares the
 * endpoint-specific hooks and shapes the inbound DataPlaneAuthCtx into the
 * intersection auth type the kit needs.
 *
 * Why the intersection? `MessagesAttemptAuth` has `{ownerId?, pin?, copilot?}`
 * but no `apiKeyId`. The kit requires `TAuth extends KitAuthCtx` so it can
 * run quota + tag telemetry. The wrapper-local
 * `MessagesServeAuth = MessagesAttemptAuth & KitAuthCtx` satisfies the kit
 * without touching the existing attempt-auth type — structural typing means
 * the extra `apiKeyId` field is ignored when `runAttempt` forwards `auth` to
 * `messagesAttempt.generate`.
 *
 * Reference: Spec 10 §3.4. Pattern mirrors chat-completions/serve.ts.
 */
import { serveTemplate, type KitAuthCtx, type ServeTemplateHooks } from '@vnext-gateway/chat-flow-kit'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseMessagesPayload } from '../../parsers.ts'
import { kitDeps } from '../shared/kit-deps.ts'
import type { DispatchObsCtx } from '../shared/obs-ctx.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import { messagesAttempt, type MessagesAttemptAuth, type MessagesAttemptResult } from './attempt.ts'
import { respondMessages } from './respond.ts'

export interface MessagesServeArgs {
  /** Pre-parsed JSON body from http.ts (`await c.req.json()`). */
  readonly raw: unknown
  readonly auth: DataPlaneAuthCtx
  readonly obsCtx: DispatchObsCtx
  /**
   * Optional client-side abort signal (Hono's `c.req.raw.signal`). The kit
   * links this into the downstream controller so a client disconnect mid-SSE
   * cancels provider.fetch + parseMessagesStream.
   */
  readonly signal?: AbortSignal
}

type MessagesPayload = Record<string, unknown> & { model: string; stream?: boolean }

type MessagesServeAuth = MessagesAttemptAuth & KitAuthCtx

const messagesHooks: ServeTemplateHooks<
  MessagesPayload,
  MessagesAttemptResult,
  undefined,
  MessagesServeAuth,
  TelemetryRequestContext
> = {
  endpointTag: 'messages',

  parse: ({ raw }) => {
    try {
      return parseMessagesPayload(raw) as MessagesPayload
    } catch (err) {
      // Re-throw with the {status, body} shape kitDeps.jsonErrorWrap consumes.
      // Default body matches the Anthropic-shaped envelope clients expect.
      const e = err as Error & { status?: number; body?: unknown }
      const wrapped = new Error(e.message) as Error & { status?: number; body?: unknown }
      wrapped.status = e.status ?? 400
      wrapped.body = e.body ?? {
        type: 'error',
        error: { type: 'invalid_request_error', message: e.message },
      }
      throw wrapped
    }
  },

  wantsStream: (p) => p.stream === true,

  runAttempt: (a) => messagesAttempt.generate({
    payload: a.payload,
    // Structural typing: extra apiKeyId on auth is ignored by attempt.
    auth: a.auth,
    ctx: { requestStartedAt: a.requestStartedAt, downstreamAbortSignal: a.downstreamAbortSignal },
    telemetryCtx: a.telemetryCtx,
  }),

  respond: (r, c) => respondMessages(r, {
    wantsStream: c.wantsStream,
    downstreamAbortController: c.downstreamAbortController,
    telemetryCtx: c.telemetryCtx,
  }),
}

export async function serveMessages(args: MessagesServeArgs): Promise<Response> {
  const auth: MessagesServeAuth = {
    ownerId: args.auth.userId,
    copilot: args.auth.copilot,
    apiKeyId: args.auth.apiKeyId,
  }
  const { response } = await serveTemplate(
    messagesHooks,
    { raw: args.raw, auth, obsCtx: args.obsCtx, signal: args.signal, extras: {} },
    kitDeps,
  )
  return response
}
```

- [ ] **Step 4: Typecheck the gateway package**

Run: `cd vnext && bun --filter '@vnext-llm/gateway' run typecheck`
Expected: PASS.

- [ ] **Step 5: Re-run the messages test directory**

Run: `cd vnext && bun test packages/gateway/tests/data-plane/chat-flow/messages/`
Expected: PASS — same green count as Step 2. attempt/respond/interceptors all untouched.

- [ ] **Step 6: Commit**

```bash
cd vnext
git add packages/gateway/src/data-plane/chat-flow/messages/serve.ts
git commit -m "refactor(vnext/spec10): migrate messages serve to chat-flow-kit

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

---

## Task 2: Migrate `gemini/serve.ts`

Gemini is the trickier case: the URL-derived `model` + `forceStream` flags don't live on the payload, so they ride in `input.extras` and the hook reads them back out. `wantsStream` reads from `input.extras.forceStream`, NOT from the payload.

**Files:**
- Modify (rewrite): `vnext/packages/gateway/src/data-plane/chat-flow/gemini/serve.ts`

- [ ] **Step 1: Verify `GeminiAttemptResult` / `GeminiAttemptAuth` are exported**

Run: `cd vnext && grep -E "^export (type|interface) (GeminiAttemptResult|GeminiAttemptAuth)" packages/gateway/src/data-plane/chat-flow/gemini/attempt.ts`
Expected: two matches. Both already exported (verified at plan-write time: lines 71, 73).

- [ ] **Step 2: Baseline — run the gemini test directory**

Run: `cd vnext && bun test packages/gateway/tests/data-plane/chat-flow/gemini/`
Expected: PASS. Green baseline.

- [ ] **Step 3: Rewrite `gemini/serve.ts` to the hook-declaration shape**

Overwrite the file in full:

```ts
// vnext/packages/gateway/src/data-plane/chat-flow/gemini/serve.ts
/**
 * Gemini generate/stream HTTP serve layer (Spec 10 — chat-flow convergence).
 *
 * Migrated to the framework kit (@vnext-gateway/chat-flow-kit). Differences
 * vs the other three endpoints:
 *   - Gemini payloads do NOT carry `model` — it's URL-derived. `model` and
 *     `forceStream` (URL verb: `generateContent` vs `streamGenerateContent`)
 *     ride through `input.extras`; the hook reads them back out.
 *   - `wantsStream` reads `extras.forceStream`, NOT `payload.stream` — the
 *     client's stream intent is encoded in the URL verb, not the body.
 *   - `runAttempt` forwards both `extras.model` and `extras.forceStream` to
 *     `geminiAttempt.generate` alongside the parsed payload.
 *
 * Why the intersection auth? Same reasoning as messages/chat-completions:
 * `GeminiAttemptAuth` already declares `apiKeyId?: string`, so technically
 * `GeminiAttemptAuth & KitAuthCtx` adds nothing structurally — but we keep
 * the intersection alias for symmetry with the other three endpoints and so
 * a future change to `GeminiAttemptAuth` that drops `apiKeyId` doesn't
 * silently break the kit's quota path.
 *
 * Reference: Spec 10 §3.4. Pattern mirrors messages/serve.ts.
 */
import { serveTemplate, type KitAuthCtx, type ServeTemplateHooks } from '@vnext-gateway/chat-flow-kit'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseGeminiPayload } from '../../parsers.ts'
import { kitDeps } from '../shared/kit-deps.ts'
import type { DispatchObsCtx } from '../shared/obs-ctx.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import { geminiAttempt, type GeminiAttemptAuth, type GeminiAttemptResult } from './attempt.ts'
import { respondGemini } from './respond.ts'

export interface GeminiServeArgs {
  /** Pre-parsed JSON body from http.ts (`await c.req.json()`). */
  readonly raw: unknown
  /**
   * Bare model name extracted from the URL path. Gemini payloads do not carry
   * `model`, so the route handler peels it from `/v1beta/models/<model>:<verb>`.
   */
  readonly model: string
  /**
   * True when the URL verb was `streamGenerateContent` (client wants SSE).
   * False when it was `generateContent`. Threaded through attempt (so upstream
   * negotiates a stream) AND respond.ts (which decides the wire shape).
   */
  readonly forceStream: boolean
  readonly auth: DataPlaneAuthCtx
  readonly obsCtx: DispatchObsCtx
  readonly signal?: AbortSignal
}

type GeminiPayload = Record<string, unknown> & { stream?: boolean }

type GeminiServeAuth = GeminiAttemptAuth & KitAuthCtx

const geminiHooks: ServeTemplateHooks<
  GeminiPayload,
  GeminiAttemptResult,
  undefined,
  GeminiServeAuth,
  TelemetryRequestContext
> = {
  endpointTag: 'gemini',

  parse: ({ raw }) => {
    try {
      return parseGeminiPayload(raw) as GeminiPayload
    } catch (err) {
      const e = err as Error & { status?: number; body?: unknown }
      const wrapped = new Error(e.message) as Error & { status?: number; body?: unknown }
      wrapped.status = e.status ?? 400
      wrapped.body = e.body ?? {
        error: { code: 400, message: e.message, status: 'INVALID_ARGUMENT' },
      }
      throw wrapped
    }
  },

  // forceStream lives in extras (URL-derived), not on the payload body.
  wantsStream: (_payload, input) => input.extras.forceStream === true,

  runAttempt: (a) => geminiAttempt.generate({
    payload: a.payload,
    model: a.extras.model as string,
    forceStream: a.extras.forceStream === true,
    auth: a.auth,
    ctx: { requestStartedAt: a.requestStartedAt, downstreamAbortSignal: a.downstreamAbortSignal },
    telemetryCtx: a.telemetryCtx,
  }),

  respond: (r, c) => respondGemini(r, {
    wantsStream: c.wantsStream,
    downstreamAbortController: c.downstreamAbortController,
    telemetryCtx: c.telemetryCtx,
  }),
}

export async function serveGemini(args: GeminiServeArgs): Promise<Response> {
  const auth: GeminiServeAuth = {
    ownerId: args.auth.userId,
    copilot: args.auth.copilot,
    apiKeyId: args.auth.apiKeyId,
  }
  const { response } = await serveTemplate(
    geminiHooks,
    {
      raw: args.raw,
      auth,
      obsCtx: args.obsCtx,
      signal: args.signal,
      extras: { model: args.model, forceStream: args.forceStream },
    },
    kitDeps,
  )
  return response
}
```

- [ ] **Step 4: Typecheck the gateway package**

Run: `cd vnext && bun --filter '@vnext-llm/gateway' run typecheck`
Expected: PASS.

- [ ] **Step 5: Re-run the gemini test directory**

Run: `cd vnext && bun test packages/gateway/tests/data-plane/chat-flow/gemini/`
Expected: PASS — same green count as Step 2. attempt/respond/state-bridge/reshape-count untouched.

- [ ] **Step 6: Commit**

```bash
cd vnext
git add packages/gateway/src/data-plane/chat-flow/gemini/serve.ts
git commit -m "refactor(vnext/spec10): migrate gemini serve to chat-flow-kit

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

---

## Task 3: Acceptance gates for Part 3

After three of four endpoints are converged we re-run the same A1-A4 subset Part 2 used.

**Files:**
- Verify (no edits): all files touched in Tasks 1-2.

- [ ] **Step 1: A1 subset — full workspace test pass**

Run: `cd vnext && bun run test`
Expected: PASS. Wider blast radius now includes anything that round-trips through `serveMessages` / `serveGemini` (http.ts handlers, integration tests, server tool tests, snapshot sidecar tests).

- [ ] **Step 2: A2 subset — kit + gateway typecheck**

Run: `cd vnext && bun --filter '@vnext-gateway/chat-flow-kit' run typecheck && bun --filter '@vnext-llm/gateway' run typecheck`
Expected: PASS for both packages.

- [ ] **Step 3: A3 subset — framework purity gate**

Run: `cd vnext && bun run check:framework-purity`
Expected: PASS. The new serves import the kit; the kit still imports nothing from `@vnext-llm/*`.

- [ ] **Step 4: A4 reference — line counts for migrated serves**

Run: `cd vnext && wc -l packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts packages/gateway/src/data-plane/chat-flow/messages/serve.ts packages/gateway/src/data-plane/chat-flow/gemini/serve.ts`
Expected: all three noticeably smaller than their pre-Spec-10 baselines (chat-completions ~115, messages ~120, gemini ~128). Spec target: chat-completions / messages well under 60; gemini may be slightly higher due to the `extras` bookkeeping but still well under the baseline. Don't fail the task on exact line counts — A4 is goal-based.

- [ ] **Step 5: Diff review — three-endpoint shape parity**

Run: `cd vnext && diff -u packages/gateway/src/data-plane/chat-flow/chat-completions/serve.ts packages/gateway/src/data-plane/chat-flow/messages/serve.ts || true`
Expected: the diff is small enough that it's obvious the two files share the same skeleton (only types, payload shape, error-body shape, and the names imported from `./attempt.ts` / `./respond.ts` differ). If the diff is structurally large (e.g. one has manual quota or controller code that the other doesn't), something drifted — go back and reconcile.

Run: `cd vnext && wc -l packages/gateway/src/data-plane/chat-flow/{chat-completions,messages,gemini}/serve.ts`
Eyeball: confirm gemini's file is the largest of the three (it carries the extras bag), but still in the same ballpark — not 2× the size of messages.

- [ ] **Step 6 (optional): Local Docker smoke prep is NOT done here**

A6 (Docker `--no-cache` build) waits until Part 4 — `responses/serve.ts` still needs to migrate and the Dockerfile COPY list doesn't change between Parts 2-3 (`@vnext-gateway/chat-flow-kit/package.json` is added once in Part 1). No action needed in Part 3.

---

## Self-Review

### Spec coverage

| Spec §/Acceptance | Where in this plan |
| --- | --- |
| §3.4 messages adapter shape | Task 1 Step 3 |
| §3.4 gemini adapter shape (extras for `model` + `forceStream`) | Task 2 Step 3 |
| §3.4 intersection auth pattern (`<Endpoint>ServeAuth = AttemptAuth & KitAuthCtx`) | Tasks 1 & 2 Step 3 |
| §3.4 auth shaping happens in wrapper, not in kit | Tasks 1 & 2 Step 3 — `serveMessages` / `serveGemini` body |
| §3.4 `wantsStream` reads `extras.forceStream` for gemini | Task 2 Step 3 — `wantsStream` hook |
| A1 (`bun test` still passes) | Tasks 1 & 2 Steps 5; Task 3 Step 1 |
| A2 (kit + gateway typecheck) | Tasks 1 & 2 Step 4; Task 3 Step 2 |
| A3 (framework purity gate) | Task 3 Step 3 |
| A4 (serve.ts shrinks to a thin wrapper) | Task 3 Steps 4, 5 |
| A5 (kit-level unit suite) | covered in Part 1 |
| A6 (Docker `--no-cache` build) | deferred to Part 4 |
| A7 (live smoke) | deferred to deploy window |

### Placeholder scan

- No TBD/TODO/"fill in later" markers.
- Every code step contains the full file contents.
- Commands include their expected outcome.
- Both rewrites preserve the existing error-envelope shape (Anthropic-style for messages, Gemini-style for gemini) by setting the default `body` inside `parse`'s catch.

### Type consistency

- `MessagesServeAuth = MessagesAttemptAuth & KitAuthCtx` (Task 1) — same shape as `ChatCompletionsServeAuth` in Part 2.
- `GeminiServeAuth = GeminiAttemptAuth & KitAuthCtx` (Task 2) — `GeminiAttemptAuth` already declares `apiKeyId?: string`, so the intersection is structurally a no-op today; the alias is kept for **symmetry** with the other three endpoints and as a defense against future changes that drop `apiKeyId` from the attempt-auth type. The module header in Task 2 Step 3 calls this out explicitly so a future reader doesn't delete the alias as dead code.
- `MessagesAttemptResult` (re-exported in Task 1) and `GeminiAttemptResult` (re-exported in Task 2) are the `TAttemptResult` generics — same names as in `attempt.ts`, end-to-end.
- `extras: { model, forceStream }` (Task 2) — `wantsStream` reads `input.extras.forceStream === true` (with strict equality, not `Boolean(...)`, to match the legacy `args.forceStream` semantics); `runAttempt` casts `extras.model as string` (safe because the wrapper only ever puts a string there). If a future endpoint passes `model` of a different type, the cast localises the failure.

### Edge cases worth flagging for the implementer

- **Order of operations is fixed by the kit.** Per Part 1's spec §3.3, the kit runs `parse → preProcess → wantsStream → buildTelemetryCtx → runQuotaGate → linked AbortController → runAttempt → respond`. Compared to the pre-Spec-10 messages/gemini serves, the only observable order change is that **`telemetryCtx` is built AFTER `wantsStream` is decided** (so `isStreaming` is passed in correctly) and **BEFORE `runQuotaGate`** (so the quota response doesn't carry telemetry). The legacy serves did the same — just inlined. No behaviour change.
- **`requestStartedAt` semantics.** The kit captures `requestStartedAt` once and passes it through `RunAttemptArgs.requestStartedAt` and into `buildTelemetryCtx`. The hooks then forward it into attempt's `RequestContext.requestStartedAt`. End-to-end this gives the same single-timestamp-per-request property the legacy serves had.
- **`signal` propagation.** The kit's linked controller is built from `input.signal`. It mirrors exactly what the four legacy serves did (`if signal.aborted → abort()`, else `addEventListener('abort', ..., {once:true})`). The hooks receive the same `downstreamAbortSignal` they did before (via attempt's `ctx`) and the same `downstreamAbortController` (via respond's args).
- **What is NOT migrated here.** `responses/serve.ts` keeps its current shape until Part 4 because of the `expandPreviousResponseId` + `PreviousResponseNotFoundError` short-circuit. The wider workspace test in Task 3 Step 1 will still exercise the unmigrated `serveResponses` — it must keep passing unchanged.
- **`MessagesAttemptResult` export check.** Task 1 Step 1 grep is defensive — if the type happens to be declared without `export`, the migration fails to typecheck at the `serve.ts` import. The grep catches this before we waste time on the rewrite.
