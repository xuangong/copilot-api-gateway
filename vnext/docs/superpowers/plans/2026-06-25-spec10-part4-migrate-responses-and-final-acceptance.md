# Spec 10 Part 4 — Migrate responses serve + Dockerfile + final acceptance

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the last and most complex endpoint (`responses/serve.ts`) onto `serveTemplate` using `preProcess` for `expandPreviousResponseId` + the `PreviousResponseNotFoundError` short-circuit, with `mergedInputItems` carried as the kit's `extra`. Then wire `@vnext-gateway/chat-flow-kit` into the platform-bun Dockerfile (A6) and run the full A1–A4/A6 acceptance suite — closing out Spec 10 to the boundary where vNext can serve any vertical.

**Architecture:** Responses is the only endpoint that needs `preProcess` (expand `previous_response_id` against the responses store) and a typed `extra` channel (`mergedInputItems` flows back to `http.ts` so the snapshot sidecar can persist the full input history). The hook returns either `{kind:'continue', payload, extra: { mergedInputItems }}` to proceed, or `{kind:'short-circuit', response: renderPreviousResponseNotFound(err), extra: { mergedInputItems: [] }}` on `PreviousResponseNotFoundError` — preserving the OpenAI-verbatim 400 envelope. The wrapper maps `ServeTemplateResult<ResponsesExtra>` back to the existing `ResponsesServeResult` shape (`{ response, mergedInputItems }`) so `responses/http.ts` is untouched.

**Tech Stack:** Bun + TypeScript strict, `verbatimModuleSyntax`, `allowImportingTsExtensions`. Test runner: `bun test` (workspace-wide). Docker build via the existing `docker-compose.vnext.yml` (build context = `./vnext`).

---

## File Structure

- **Rewrite:** `vnext/packages/gateway/src/data-plane/chat-flow/responses/serve.ts` — hook declaration with `preProcess`, `ResponsesServeAuth = ResponsesAttemptAuth & KitAuthCtx` intersection, `ResponsesExtra = { readonly mergedInputItems: unknown[] }`, wrapper maps `extra?.mergedInputItems ?? []` back into `ResponsesServeResult`. Keeps `ResponsesServeArgs` / `ResponsesServeResult` interface signatures unchanged so `responses/http.ts` requires zero edits.
- **Verify (unchanged):** `vnext/packages/gateway/src/data-plane/chat-flow/responses/http.ts` — still destructures `{ response, mergedInputItems } = await serveResponses(...)` and passes `mergedInputItems` into `attachStreamSidecar` / `attachNonStreamSidecar`. Behaviour-preservation gate: the existing `snapshot-sidecar.test.ts` must remain green.
- **Verify (unchanged tests):** `vnext/packages/gateway/tests/data-plane/chat-flow/responses/{attempt.test.ts, attempt.cross.test.ts, snapshot-sidecar.test.ts}` — no `serve.test.ts` exists for responses (parity with messages/gemini), so behaviour-preservation relies on the snapshot-sidecar + attempt suites + workspace-wide `bun test`.
- **Modify:** `vnext/apps/platform-bun/Dockerfile` — add `COPY packages/chat-flow-kit/package.json packages/chat-flow-kit/` to the manifest-only pre-`bun install` block (sorted alphabetically inside the `@vnext-gateway/*` group).
- **No new test files in this part** — A5 (kit-level unit suite) is fully covered in Part 1; A1 (workspace bun test) is the regression net for Parts 3+4.

---

## Task 1: Migrate `responses/serve.ts` onto `serveTemplate` with `preProcess`

**Files:**
- Verify: `vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts` (confirm `ResponsesAttemptResult` + `ResponsesAttemptAuth` exports — both should already exist per Part 3 grep methodology).
- Rewrite: `vnext/packages/gateway/src/data-plane/chat-flow/responses/serve.ts`

- [ ] **Step 1: Verify attempt exports exist (defensive grep)**

Run: `cd vnext && grep -n "export type ResponsesAttemptResult\|export interface ResponsesAttemptAuth" packages/gateway/src/data-plane/chat-flow/responses/attempt.ts`
Expected: both lines appear (lines ~72 and ~76 respectively per current `attempt.ts`). If absent, STOP and escalate — the migration relies on both being importable.

- [ ] **Step 2: Baseline — run the existing responses test directory BEFORE rewrite**

Run: `cd vnext && bun test packages/gateway/tests/data-plane/chat-flow/responses/`
Expected: PASS. This is the green baseline we must preserve (attempt.test.ts, attempt.cross.test.ts, snapshot-sidecar.test.ts).

- [ ] **Step 3: Rewrite `responses/serve.ts` in full**

Overwrite the file completely. The hook block is larger than chat-completions / messages because responses owns `preProcess`, the `PreviousResponseNotFoundError` short-circuit, and the typed `extra` channel:

```ts
// vnext/packages/gateway/src/data-plane/chat-flow/responses/serve.ts
/**
 * /v1/responses HTTP serve layer (Spec 10 — chat-flow convergence).
 *
 * Migrated to the framework kit (@vnext-gateway/chat-flow-kit). The legacy
 * inline pipeline (parse → expandPreviousResponseId → telemetry → quota →
 * controller → attempt → respond) now flows through `serveTemplate(...)`;
 * this file declares the hooks, shapes auth, and maps the kit result back
 * to the existing `ResponsesServeResult` shape so `responses/http.ts`
 * keeps its `{ response, mergedInputItems } = await serveResponses(...)`
 * destructuring unchanged.
 *
 * Why preProcess? Responses must expand `previous_response_id` against the
 * responses store BEFORE binding selection (the upstream payload includes
 * the merged input history). The kit gives us a typed slot for exactly
 * this: `preProcess` runs between parse and quota, can mutate the payload,
 * and emits an `extra` value that threads through to `respond` AND the
 * wrapper's return. We use `extra = { mergedInputItems }` so http.ts can
 * persist the full input history in the snapshot sidecar.
 *
 * Why short-circuit on PreviousResponseNotFoundError? The OpenAI-verbatim
 * envelope (`code: 'previous_response_not_found'`, `param:
 * 'previous_response_id'`) is preserved by delegating to
 * `renderPreviousResponseNotFound(err)` — `jsonErrorWrap` strips those
 * fields and would break programmatic recovery for SDKs.
 *
 * Why the intersection auth? `ResponsesAttemptAuth` already has an
 * optional `apiKeyId`, but we keep the explicit intersection
 * (`ResponsesServeAuth = ResponsesAttemptAuth & KitAuthCtx`) for symmetry
 * with the other three endpoints and to defend against future drift if
 * either type loses the field.
 *
 * Reference: Spec 10 §3.3 (preProcess), §3.4 (responses notes).
 */
import {
  serveTemplate,
  type KitAuthCtx,
  type PreProcessResult,
  type ServeTemplateHooks,
} from '@vnext-gateway/chat-flow-kit'
import type { DataPlaneAuthCtx } from '../../models/routes.ts'
import { parseResponsesPayload } from '../../parsers.ts'
import { kitDeps } from '../shared/kit-deps.ts'
import type { DispatchObsCtx } from '../shared/obs-ctx.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import {
  expandPreviousResponseId,
  PreviousResponseNotFoundError,
} from '../../dispatch/responses-store-bridge.ts'
import { renderPreviousResponseNotFound } from '../../errors/repackage.ts'
import { getResponsesStore } from '../../../shared/runtime/responses-store.ts'
import {
  responsesAttempt,
  type ResponsesAttemptAuth,
  type ResponsesAttemptResult,
} from './attempt.ts'
import { respondResponses } from './respond.ts'

export interface ResponsesServeArgs {
  /** Pre-parsed JSON body from http.ts (`await c.req.json()`). */
  readonly raw: unknown
  readonly auth: DataPlaneAuthCtx
  readonly obsCtx: DispatchObsCtx
  /** Optional client-side abort signal (Hono's `c.req.raw.signal`). */
  readonly signal?: AbortSignal
  /** Optional request id passthrough so attempt.ts can stamp it on shortcut upstream calls. */
  readonly requestId?: string
  /** Optional User-Agent passthrough so attempt.ts can echo it into shortcut upstream calls. */
  readonly userAgent?: string
}

export interface ResponsesServeResult {
  readonly response: Response
  readonly mergedInputItems: unknown[]
}

type ResponsesPayload = Record<string, unknown> & {
  model: string
  stream?: boolean
  input?: unknown
  tools?: unknown
  previous_response_id?: string | null
}

type ResponsesServeAuth = ResponsesAttemptAuth & KitAuthCtx

type ResponsesExtra = { readonly mergedInputItems: unknown[] }

const responsesHooks: ServeTemplateHooks<
  ResponsesPayload,
  ResponsesAttemptResult,
  ResponsesExtra,
  ResponsesServeAuth,
  TelemetryRequestContext
> = {
  endpointTag: 'responses',

  parse: ({ raw }) => {
    try {
      return parseResponsesPayload(raw) as ResponsesPayload
    } catch (err) {
      const e = err as Error & { status?: number; body?: unknown }
      const wrapped = new Error(e.message) as Error & { status?: number; body?: unknown }
      wrapped.status = e.status ?? 400
      wrapped.body = e.body ?? {
        error: { type: 'invalid_request_error', message: e.message },
      }
      throw wrapped
    }
  },

  preProcess: async (payload, ctx) => {
    // Expand `previous_response_id` against the responses store. Mutates
    // payload.input in place (legacy contract from
    // `expandPreviousResponseId`); we read the expanded array off
    // payload.input so the snapshot sidecar persists the full input
    // history for the next turn.
    try {
      const store = getResponsesStore()
      await expandPreviousResponseId(
        payload as { previous_response_id?: string | null; input?: unknown },
        store,
        ctx.auth.apiKeyId ?? null,
      )
      const expanded = (payload as { input?: unknown }).input
      const mergedInputItems = Array.isArray(expanded) ? (expanded as unknown[]) : []
      return { kind: 'continue', payload, extra: { mergedInputItems } } satisfies PreProcessResult<
        ResponsesPayload,
        ResponsesExtra
      >
    } catch (err) {
      // PreviousResponseNotFoundError carries only `status: 400` (no
      // body), so we MUST delegate to renderPreviousResponseNotFound to
      // preserve the OpenAI-verbatim envelope. Generic fallback (below)
      // would strip `code` + `param` and break SDK programmatic recovery.
      if (err instanceof PreviousResponseNotFoundError) {
        return {
          kind: 'short-circuit',
          response: renderPreviousResponseNotFound(err),
          extra: { mergedInputItems: [] },
        } satisfies PreProcessResult<ResponsesPayload, ResponsesExtra>
      }
      // Any other expansion failure → re-throw with the {status, body}
      // shape `deps.jsonErrorWrap` consumes (kit's preProcess fallback
      // calls jsonErrorWrap exactly like parse).
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

  runAttempt: (a) => responsesAttempt.generate({
    payload: a.payload,
    auth: a.auth,
    ctx: { requestStartedAt: a.requestStartedAt, downstreamAbortSignal: a.downstreamAbortSignal },
    telemetryCtx: a.telemetryCtx,
    requestId: (a.extras.requestId as string | undefined),
    userAgent: (a.extras.userAgent as string | undefined),
  }),

  respond: (r, c) => respondResponses(r, {
    wantsStream: c.wantsStream,
    downstreamAbortController: c.downstreamAbortController,
    telemetryCtx: c.telemetryCtx,
  }),
}

export async function serveResponses(args: ResponsesServeArgs): Promise<ResponsesServeResult> {
  const auth: ResponsesServeAuth = {
    ownerId: args.auth.userId,
    copilot: args.auth.copilot,
    apiKeyId: args.auth.apiKeyId,
  }
  const { response, extra } = await serveTemplate(
    responsesHooks,
    {
      raw: args.raw,
      auth,
      obsCtx: args.obsCtx,
      signal: args.signal,
      // requestId / userAgent ride through extras so the image-gen
      // shortcut inside responsesAttempt can stamp them on upstream
      // image calls. They were dedicated args on the old serve; the
      // kit's RunAttemptArgs only standardises payload/auth/telemetry,
      // so per-endpoint passthroughs live in `extras`.
      extras: { requestId: args.requestId, userAgent: args.userAgent },
    },
    kitDeps,
  )
  return { response, mergedInputItems: extra?.mergedInputItems ?? [] }
}
```

- [ ] **Step 4: Typecheck the gateway package**

Run: `cd vnext && bun --filter '@vnext-llm/gateway' run typecheck`
Expected: PASS. Watch for any drift on `ResponsesAttemptArgs` (the `requestId` / `userAgent` are currently typed as `string | undefined` — the `as` casts in `runAttempt` keep TS happy).

- [ ] **Step 5: Run the full responses test directory**

Run: `cd vnext && bun test packages/gateway/tests/data-plane/chat-flow/responses/`
Expected: PASS — all three suites green. The snapshot-sidecar test is the critical gate (proves `mergedInputItems` still flows through `http.ts` → sidecar).

- [ ] **Step 6: Run the full gateway suite**

Run: `cd vnext && bun test packages/gateway`
Expected: PASS. Confirms no integration test that calls `serveResponses` (directly or via http.ts) regressed.

- [ ] **Step 7: Commit**

```bash
cd vnext
git add packages/gateway/src/data-plane/chat-flow/responses/serve.ts
git commit -m "refactor(vnext/spec10): migrate responses serve to chat-flow-kit with preProcess

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

---

## Task 2: Wire `@vnext-gateway/chat-flow-kit` into the platform-bun Dockerfile (A6)

The Dockerfile copies per-package `package.json` files into the image BEFORE `bun install` so the workspace graph resolves from manifests alone. After Part 1 created `packages/chat-flow-kit/package.json`, the Dockerfile must learn to copy it — otherwise `bun install` inside the image will silently miss the workspace symlink and downstream `import` calls from `@vnext-llm/gateway` will fail at runtime.

**Files:**
- Modify: `vnext/apps/platform-bun/Dockerfile`

- [ ] **Step 1: Add the manifest COPY line**

Insert a new line directly after the existing `COPY packages/cache/package.json packages/cache/` line. The line must read:

```dockerfile
COPY packages/chat-flow-kit/package.json packages/chat-flow-kit/
```

After the edit, the surrounding `@vnext-gateway/*` block (current Dockerfile lines ~17–32) should look like this — note `chat-flow-kit` inserted alphabetically between `cache` and `http`:

```dockerfile
COPY packages/gateway/package.json packages/gateway/
COPY packages/platform/package.json packages/platform/
COPY packages/protocols-llm/package.json packages/protocols-llm/
COPY packages/result/package.json packages/result/
COPY packages/service/package.json packages/service/
COPY packages/upstream/package.json packages/upstream/
COPY packages/provider-llm/package.json packages/provider-llm/
COPY packages/provider-azure/package.json packages/provider-azure/
COPY packages/provider-copilot/package.json packages/provider-copilot/
COPY packages/provider-custom/package.json packages/provider-custom/
COPY packages/provider-sdf/package.json packages/provider-sdf/
COPY packages/responses-store/package.json packages/responses-store/
COPY packages/cache/package.json packages/cache/
COPY packages/chat-flow-kit/package.json packages/chat-flow-kit/
COPY packages/http/package.json packages/http/
COPY packages/translate/package.json packages/translate/
```

(The block isn't sorted strictly alphabetically today — `gateway` precedes `platform`, `result` precedes `service`, `provider-*` are grouped together, `cache` lands at the bottom. Don't reorder. Only insert the new line in its natural alphabetical neighbourhood after `cache` to keep the diff minimal and reviewable.)

- [ ] **Step 2: A6 — Docker no-cache build smoke**

Run: `cd vnext && docker build --no-cache -f apps/platform-bun/Dockerfile -t vnext-platform-bun:spec10 .`
Expected: build completes successfully. Watch the `bun install` step — it should NOT log `warn: workspace package "@vnext-gateway/chat-flow-kit" not found`. Watch `bun run build:ui` — it should still complete (unrelated, but it's in the same build).

If the build fails with a missing-workspace warning, double-check the COPY line is present and the path matches the actual on-disk location.

- [ ] **Step 3: Commit**

```bash
cd vnext
git add apps/platform-bun/Dockerfile
git commit -m "build(vnext/spec10): add chat-flow-kit package manifest to platform-bun Dockerfile

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

---

## Task 3: Final acceptance — A1 / A2 / A3 / A4 / A6

Re-run the full acceptance suite now that all four endpoints have migrated. A5 was covered in Part 1 (kit-level unit suite); A7 (live smoke) is explicitly deferred to the deploy window per the project constraint "no CFW deploy until vNext refactor fully polished."

**Files:** verification only — no edits.

- [ ] **Step 1: A1 — Full workspace test pass**

Run: `cd vnext && bun run test`
Expected: PASS. The `test` script runs framework-purity check first, then `bun test` workspace-wide. All four endpoints + the kit's own suite + every integration test must remain green.

- [ ] **Step 2: A2 — Kit + gateway typecheck**

Run: `cd vnext && bun --filter '@vnext-gateway/chat-flow-kit' run typecheck && bun --filter '@vnext-llm/gateway' run typecheck`
Expected: PASS for both. Captures any latent generic-variance bug now that all four endpoints exercise the kit's `<TPayload, TAttemptResult, TExtra, TAuth, TTelemetryCtx>` shape (chat-completions/messages/gemini use `TExtra = undefined`; only responses uses a real extra).

- [ ] **Step 3: A3 — Framework purity gate**

Run: `cd vnext && bun run check:framework-purity`
Expected: PASS. The kit src tree must contain zero imports from any `@vnext-llm/*` and zero literal occurrences of `chat_completions` / `messages` / `responses` / `gemini` / `Copilot` / `Anthropic` / `OpenAI`.

Then run the manual `rg` audit the spec calls for:

```bash
cd vnext && rg "@vnext-llm" packages/chat-flow-kit/src/
cd vnext && rg -w 'chat_completions|messages|responses|gemini|Copilot|Anthropic|OpenAI' packages/chat-flow-kit/src/
```

Both must print no matches. If `endpointTag: '...'` appears in any kit test fixture, that's caller-supplied — it doesn't violate the rule because the kit treats it as opaque (passes it straight to `deps.buildTelemetryCtx`). The check is for these strings showing up in kit production code paths (comparisons, switches, conditionals).

- [ ] **Step 4: A4 — Line count audit across all four serves**

Run: `cd vnext && wc -l packages/gateway/src/data-plane/chat-flow/{chat-completions,messages,responses,gemini}/serve.ts`
Expected (per spec §A4 floor):
- chat-completions: was ~115, should be well under 60 (target ~45–55).
- messages: was ~120, should be well under 60 (target ~50–60).
- responses: was ~178, may stay larger due to preProcess + the not-found short-circuit + extra remap (target ~100–130 inline; could go lower if split into a sibling `hooks.ts`, but DO NOT split purely to hit a line count — spec §A4 explicitly says "don't").
- gemini: was ~128, should be well under 80 (target ~60–75) due to the extras-based wantsStream/runAttempt being slightly heavier than chat-completions.

A4 is goal-based, not a hard count. If responses lands at 135 lines with the hook inline and the result is readable, that's fine. The boilerplate (parse-catch, telemetry construction, quota call, controller linking, attempt invocation, respond call) MUST be gone — that's the real gate, not the line count.

- [ ] **Step 5: A4 supplementary — confirm boilerplate is gone**

Run: `cd vnext && rg -n "runQuotaGate|new AbortController|requestStartedAt = Date.now" packages/gateway/src/data-plane/chat-flow/{chat-completions,messages,responses,gemini}/serve.ts`
Expected: no matches in any of the four serve files. All three of those concerns now live inside `serveTemplate` / `kitDeps`. If any match remains, the migration is incomplete for that endpoint.

- [ ] **Step 6: A6 — Re-run the no-cache docker build (final gate)**

Run: `cd vnext && docker build --no-cache -f apps/platform-bun/Dockerfile -t vnext-platform-bun:spec10-final .`
Expected: PASS. Same as Task 2 Step 2, but re-run here so the final acceptance is a single bundle the reviewer can replay.

- [ ] **Step 7: A7 status note (no action — deferred)**

A7 (live smoke) is explicitly deferred per spec §A7 ("deferred to deploy window") AND the project-level constraint "no CFW deploy until vNext refactor fully polished" (see `spec8_execution_constraints.md` memory). Do NOT attempt the live smoke as part of Part 4 — it runs as a separate work item once the user opens the deploy window.

Document this in the final commit message body (Step 8) so the deployment checklist is preserved.

- [ ] **Step 8: Final wrap-up commit (markdown / acceptance log only — code changes already committed above)**

There are no source edits in this task — it's verification only. If you want to record the acceptance run, create a brief `vnext/docs/superpowers/research/2026-06-25-spec10-acceptance-log.md` with the command outputs (paste the `wc -l` results, the docker build last line, the test summary). Skip if not customary in this repo — `git log` already tells the story.

If recording, commit:

```bash
cd vnext
git add docs/superpowers/research/2026-06-25-spec10-acceptance-log.md
git commit -m "docs(vnext/spec10): record final A1-A4/A6 acceptance log

A7 live smoke deferred to deploy window per spec + project constraint.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

---

## Self-Review

### Spec coverage

| Spec §/Acceptance | Where in this plan |
| --- | --- |
| §3.3 `preProcess` skeleton position (step 2) | Task 1 Step 3 — `responsesHooks.preProcess` |
| §3.3 `preProcess` short-circuit semantics (skip quota/attempt) | Task 1 Step 3 — `PreviousResponseNotFoundError` branch returns `{kind:'short-circuit', response, extra}` |
| §3.3 `preProcess` continue + payload mutation | Task 1 Step 3 — payload is mutated in-place by `expandPreviousResponseId`; returned as `{kind:'continue', payload, extra:{mergedInputItems}}` |
| §3.3 `preProcess` throw → jsonErrorWrap fallback | Task 1 Step 3 — non-not-found error path re-throws with `{status, body}` |
| §3.4 responses notes — `extra = {mergedInputItems}` flow back to wrapper | Task 1 Step 3 — `serveResponses` returns `{ response, mergedInputItems: extra?.mergedInputItems ?? [] }` |
| §3.4 responses intersection auth | Task 1 Step 3 — `ResponsesServeAuth = ResponsesAttemptAuth & KitAuthCtx` |
| §3.4 OpenAI-verbatim envelope preservation | Task 1 Step 3 — delegates to `renderPreviousResponseNotFound` instead of generic `jsonErrorWrap` |
| A1 (workspace `bun test`) | Task 1 Steps 5,6; Task 3 Step 1 |
| A2 (kit + gateway typecheck) | Task 1 Step 4; Task 3 Step 2 |
| A3 (framework purity gate + manual rg) | Task 3 Step 3 |
| A4 (serve.ts shrinks; boilerplate gone) | Task 3 Steps 4, 5 |
| A5 (kit-level unit suite) | covered in Part 1 — not re-tested here |
| A6 (Dockerfile + `--no-cache` build) | Task 2 Steps 1–3; Task 3 Step 6 |
| A7 (live smoke) | Task 3 Step 7 — deferred per spec + project constraint |

### Placeholder scan

- No TBD / TODO / "fill in later" markers anywhere.
- Every code step contains the full code to write or the full command to run.
- Command-expected outputs are concrete and falsifiable (PASS / FAIL with specific failure modes).
- Line-count targets are stated as ranges + explicitly flagged as goal-based, not hard gates.

### Type consistency

- `ResponsesServeAuth` (Task 1) intersects `ResponsesAttemptAuth` (re-exported in Step 3's imports) with `KitAuthCtx` (from the kit). `ResponsesAttemptAuth` already has `apiKeyId?: string` (confirmed in attempt.ts:80), so the intersection is structurally a no-op today — the alias is kept for symmetry with chat-completions/messages/gemini and as defence against future drift. The module header documents this so future readers don't delete it as dead code.
- `ResponsesExtra = { readonly mergedInputItems: unknown[] }` is the kit's `TExtra` generic for this endpoint. It threads through `serveTemplate<TPayload, TAttemptResult, TExtra=ResponsesExtra, TAuth, TTelemetryCtx>` → `ServeTemplateResult<ResponsesExtra>` → wrapper destructures `extra?.mergedInputItems` (nullable because `preProcess` is optional in the type, even though responses always defines it — the result type accommodates endpoints that don't).
- `ResponsesAttemptResult` (re-exported in Step 3) matches the existing attempt.ts export (line ~72). Same name end-to-end.
- `TelemetryRequestContext` flows the same way as in Parts 2 & 3: `kitDeps` binds `TTelemetryCtx = TelemetryRequestContext`, the hook generic declares it, `runAttempt`'s `a.telemetryCtx` is typed as `TelemetryRequestContext`, attempt.generate's signature accepts the same type — no `as` casts needed at the boundary.
- `PreProcessResult<ResponsesPayload, ResponsesExtra>` `satisfies` annotation is used twice in `preProcess` to catch generic-arg mismatches at the call site rather than the kit boundary.

### Edge cases worth flagging for the implementer

- **`expandPreviousResponseId` mutates `payload.input` in place** — this is the legacy contract from `responses-store-bridge.ts`. The hook captures the post-mutation array via `(payload as { input?: unknown }).input` AFTER the await. Don't rewrite this to "capture before await + use the return value" — `expandPreviousResponseId` returns `Promise<void>`, not the merged array.
- **`PreviousResponseNotFoundError` carries `status: 400` but no `body`** — the generic `jsonErrorWrap` fallback would strip `code: 'previous_response_not_found'` and `param: 'previous_response_id'`, breaking SDK programmatic recovery. The `instanceof` check + delegation to `renderPreviousResponseNotFound` is non-negotiable. This is the single most fragile invariant in Part 4 — if a future refactor swaps these, the responses SDK contract breaks silently.
- **`requestId` / `userAgent` via `extras`** — the kit's `RunAttemptArgs` only standardises `payload / auth / telemetryCtx / downstreamAbortSignal / requestStartedAt / extras`. The legacy `responsesAttempt.generate` accepts `requestId` and `userAgent` as top-level fields (for the image-gen shortcut). We thread them through `input.extras` (kit-agnostic key-value bag) and unpack them in `runAttempt`. Same pattern gemini uses for `model` / `forceStream` in Part 3 — keeps the kit's surface area minimal.
- **`http.ts` is intentionally untouched** — it still destructures `{ response, mergedInputItems } = await serveResponses(args)`. The wrapper's return type (`ResponsesServeResult`) is unchanged. If you find yourself editing `http.ts`, STOP — Part 4 is purely a serve-layer migration.
- **`snapshot-sidecar.test.ts` is the critical behaviour-preservation gate** — it exercises the full `http.ts → serveResponses → response + mergedInputItems → attachStreamSidecar` flow. If it breaks, the `mergedInputItems` propagation regressed; investigate the `preProcess` extra → `serveTemplate` extra → wrapper return chain before touching anything else.
- **A4 line count for responses may exceed 130 inline.** The spec explicitly allows splitting hooks into a sibling `hooks.ts` if inlining hurts readability, BUT also says "don't split purely to hit a line count." Judgement call for the implementer: if the resulting `serve.ts` reads cleanly with the hook inline, leave it; only split if the hook block visually drowns the wrapper. Don't pre-emptively split during Part 4 — review the final file first.
- **Dockerfile COPY ordering is informational, not strictly alphabetical.** Don't reorder the existing block. Insert the new line in its natural neighbourhood (after `cache`) so the diff is minimal and the rebase blast radius is one line.
- **A7 (live smoke) defer is intentional and required.** Project memory `spec8_execution_constraints.md` says "no CFW deploy until vNext refactor fully polished." Spec 10 closes the framework boundary but the broader vNext promotion (vNext → main, final-name rename, CFW deploy) is its own work item. Do NOT attempt live smoke in Part 4 even if local docker passes.
