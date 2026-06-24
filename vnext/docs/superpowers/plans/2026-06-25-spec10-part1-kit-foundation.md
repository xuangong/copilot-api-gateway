# Spec 10 Part 1 — `@vnext-gateway/chat-flow-kit` foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the new framework package `@vnext-gateway/chat-flow-kit` with the `serveTemplate` skeleton, hook/DI types, and a kit-level unit test suite — without touching any existing endpoint serve. This part lands the kit in isolation so subsequent parts can migrate one endpoint at a time.

**Architecture:** Brand-new workspace package at `vnext/packages/chat-flow-kit/`, peer to `@vnext-gateway/upstream` / `@vnext-gateway/service`. Single public entry `serveTemplate(hooks, input, deps)` that runs the fixed 9-step skeleton (parse → preProcess → wantsStream → buildTelemetryCtx → quotaGate → linked AbortController → runAttempt → respond → return). Zero `@vnext-llm/*` imports, zero LLM string literals — enforced automatically by `vnext/scripts/check-framework-purity.ts` (already in place).

**Tech Stack:** Bun + TypeScript (strict, `verbatimModuleSyntax`, `allowImportingTsExtensions`). Test runner: `bun test`. No runtime deps; the kit ships pure types + one function.

**Scope reminder (from spec §2):**
- Part 1 only: kit package + tests. No edits to `vnext/packages/gateway/` in this part.
- Acceptance covered here: **A5** (kit unit suite). A1–A4/A6/A7 land in Parts 2–4.

---

## File Structure

**New files (all under `vnext/packages/chat-flow-kit/`):**

- `package.json` — name `@vnext-gateway/chat-flow-kit`, exports `./src/index.ts`.
- `tsconfig.json` — extends `../../tsconfig.base.json`.
- `src/index.ts` — re-exports the public surface from `./serve-template.ts`.
- `src/serve-template.ts` — all types (`KitAuthCtx`, `KitObsCtx`, `ServeTemplateInput`, `PreProcessCtx`, `PreProcessResult`, `RunAttemptArgs`, `RespondCtx`, `ServeTemplateHooks`, `ServeTemplateDeps`, `ServeTemplateResult`) + the `serveTemplate` function body.
- `src/serve-template.test.ts` — kit-level unit suite covering A5: skeleton order, parse error path (default + override), preProcess short-circuit, preProcess continue + payload mutation, quota-gate short-circuit, AbortController linking, respond receives final payload + extra.

**Files NOT touched in Part 1:**
- `vnext/packages/gateway/**` — left alone; migration happens Part 2+.
- `vnext/apps/platform-bun/Dockerfile` — wired in Part 4 (A6 build check).
- The four endpoint `serve.ts` files — migrated Part 2–4.

---

## Task 1 — Scaffold the package

**Files:**
- Create: `vnext/packages/chat-flow-kit/package.json`
- Create: `vnext/packages/chat-flow-kit/tsconfig.json`
- Create: `vnext/packages/chat-flow-kit/src/index.ts`
- Create: `vnext/packages/chat-flow-kit/src/serve-template.ts`

### Steps

- [ ] **Step 1: Create `package.json`**

Write `vnext/packages/chat-flow-kit/package.json`:

```json
{
  "name": "@vnext-gateway/chat-flow-kit",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

Mirrors `vnext/packages/upstream/package.json` — no runtime deps, peer-of-`@vnext-gateway/*`.

- [ ] **Step 2: Create `tsconfig.json`**

Write `vnext/packages/chat-flow-kit/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}
```

Same shape as `vnext/packages/upstream/tsconfig.json`.

- [ ] **Step 3: Create stub `src/index.ts`**

Write `vnext/packages/chat-flow-kit/src/index.ts`:

```ts
export * from './serve-template.ts'
```

- [ ] **Step 4: Create stub `src/serve-template.ts`**

Write `vnext/packages/chat-flow-kit/src/serve-template.ts` with an intentionally-failing single export so the next task's tests have something to import without TS dying on a missing module:

```ts
// Spec 10 Part 1 — kit skeleton. Real types + body land in Task 3.
export function serveTemplate(): never {
  throw new Error('serveTemplate: not implemented (Spec 10 Part 1 Task 3)')
}
```

- [ ] **Step 5: Verify workspace picks up the package**

Run from `vnext/`:

```
bun install
```

Expected: succeeds with no error, `node_modules/@vnext-gateway/chat-flow-kit` symlink appears.

- [ ] **Step 6: Verify typecheck passes**

Run from `vnext/`:

```
bun --filter '@vnext-gateway/chat-flow-kit' run typecheck
```

Expected: PASS (no output, exit 0).

- [ ] **Step 7: Commit**

```
cd vnext
git add packages/chat-flow-kit
git commit -m "feat(vnext/chat-flow-kit): scaffold @vnext-gateway/chat-flow-kit package

Spec 10 Part 1 Task 1. Empty package + stub serveTemplate so subsequent
tasks can land types and tests incrementally without breaking workspace
resolution.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

---

## Task 2 — Type contract (no runtime body yet)

This task lands all the spec §3.1/§3.2 types so the test file in Task 3 can import them and compile, even before the function body exists. We TDD the body in Task 3.

**Files:**
- Modify: `vnext/packages/chat-flow-kit/src/serve-template.ts` (replace stub with full type set + still-throwing function body)

### Steps

- [ ] **Step 1: Replace `serve-template.ts` with the full type contract**

Overwrite `vnext/packages/chat-flow-kit/src/serve-template.ts` with:

```ts
// vnext/packages/chat-flow-kit/src/serve-template.ts
/**
 * Domain-neutral chat-flow serve template.
 *
 * The kit knows nothing about LLM endpoints, binding kinds, or protocol
 * literals. Callers (the LLM gateway adapter) declare endpoint-specific
 * hooks and inject env-touching collaborators via `ServeTemplateDeps`.
 *
 * Spec: vnext/docs/superpowers/specs/2026-06-24-spec10-chat-flow-convergence.md
 */

/** Minimal auth shape the kit itself reads. Adapters pass a richer
 *  `TAuth extends KitAuthCtx` (typically `<Endpoint>AttemptAuth & KitAuthCtx`)
 *  that they shape into the attempt's expected auth (e.g. `userId → ownerId`)
 *  BEFORE calling `serveTemplate`. The kit only reads `apiKeyId` for quota +
 *  telemetry, then forwards the whole object to `runAttempt`. */
export interface KitAuthCtx {
  /** Optional per-key id used for quota lookup and telemetry tagging. */
  readonly apiKeyId?: string | null
}

export interface KitObsCtx {
  readonly apiKeyId?: string | null
  readonly userAgent?: string | null
  readonly requestId?: string | null
  readonly [extra: string]: unknown
}

export interface ServeTemplateInput<TAuth extends KitAuthCtx = KitAuthCtx> {
  readonly raw: unknown
  readonly auth: TAuth
  readonly obsCtx: KitObsCtx
  readonly signal?: AbortSignal
  /** Catch-all bag for endpoint-specific side inputs (gemini model/verb,
   *  responses requestId/userAgent passthrough). Opaque to the kit. */
  readonly extras: Record<string, unknown>
}

export interface PreProcessCtx<TAuth extends KitAuthCtx = KitAuthCtx> {
  readonly auth: TAuth
}

/** preProcess returns one of two shapes: continue with a (possibly mutated)
 *  payload + extra, OR short-circuit with a Response. The short-circuit branch
 *  lets endpoints render bespoke error envelopes (e.g. responses'
 *  previous_response_not_found) without the kit knowing their wire shape. */
export type PreProcessResult<TPayload, TExtra> =
  | { kind: 'continue'; payload: TPayload; extra: TExtra }
  | { kind: 'short-circuit'; response: Response; extra: TExtra }

export interface RunAttemptArgs<TPayload, TAuth, TTelemetryCtx> {
  readonly payload: TPayload
  readonly auth: TAuth
  readonly telemetryCtx: TTelemetryCtx
  readonly downstreamAbortSignal: AbortSignal
  readonly requestStartedAt: number
  readonly extras: Record<string, unknown>
}

export interface RespondCtx<TPayload, TExtra, TTelemetryCtx> {
  readonly payload: TPayload
  readonly extra: TExtra
  readonly wantsStream: boolean
  readonly downstreamAbortController: AbortController
  readonly telemetryCtx: TTelemetryCtx
  readonly extras: Record<string, unknown>
}

export interface ServeTemplateHooks<
  TPayload,
  TAttemptResult,
  TExtra = undefined,
  TAuth extends KitAuthCtx = KitAuthCtx,
  TTelemetryCtx = unknown,
> {
  /** Caller-supplied tag. Opaque to the kit; only `deps.buildTelemetryCtx`
   *  receives it. Keeps the purity gate intact (no LLM literals in the kit). */
  readonly endpointTag: string

  parse(input: ServeTemplateInput<TAuth>): Promise<TPayload> | TPayload

  /** Optional renderer for parse() failures. Default: `deps.jsonErrorWrap`. */
  parseErrorRender?(err: Error & { status?: number; body?: unknown }): Response

  preProcess?(
    payload: TPayload,
    ctx: PreProcessCtx<TAuth>,
  ): Promise<PreProcessResult<TPayload, TExtra>>

  wantsStream(payload: TPayload, input: ServeTemplateInput<TAuth>): boolean

  runAttempt(args: RunAttemptArgs<TPayload, TAuth, TTelemetryCtx>): Promise<TAttemptResult>

  respond(
    result: TAttemptResult,
    ctx: RespondCtx<TPayload, TExtra, TTelemetryCtx>,
  ): Promise<Response>
}

export interface ServeTemplateDeps<TAuth extends KitAuthCtx, TTelemetryCtx> {
  readonly runQuotaGate: (apiKeyId: string | null | undefined) => Promise<Response | null>
  readonly jsonErrorWrap: (status: number, body: unknown) => Response
  readonly buildTelemetryCtx: (input: {
    auth: TAuth
    obsCtx: KitObsCtx
    isStreaming: boolean
    requestStartedAt: number
    endpointTag: string
  }) => TTelemetryCtx
}

export interface ServeTemplateResult<TExtra> {
  readonly response: Response
  readonly extra: TExtra | undefined
}

export async function serveTemplate<
  TPayload,
  TAttemptResult,
  TExtra = undefined,
  TAuth extends KitAuthCtx = KitAuthCtx,
  TTelemetryCtx = unknown,
>(
  _hooks: ServeTemplateHooks<TPayload, TAttemptResult, TExtra, TAuth, TTelemetryCtx>,
  _input: ServeTemplateInput<TAuth>,
  _deps: ServeTemplateDeps<TAuth, TTelemetryCtx>,
): Promise<ServeTemplateResult<TExtra>> {
  throw new Error('serveTemplate: not implemented (Spec 10 Part 1 Task 3)')
}
```

- [ ] **Step 2: Typecheck passes**

Run from `vnext/`:

```
bun --filter '@vnext-gateway/chat-flow-kit' run typecheck
```

Expected: PASS (exit 0).

- [ ] **Step 3: Framework purity passes**

Run from `vnext/`:

```
bun run scripts/check-framework-purity.ts
```

Expected: PASS. The kit has no `@vnext-llm/*` imports.

- [ ] **Step 4: Commit**

```
cd vnext
git add packages/chat-flow-kit/src/serve-template.ts
git commit -m "feat(vnext/chat-flow-kit): declare ServeTemplate type contract

Spec 10 Part 1 Task 2. All hook/DI/result types per spec §3.1–§3.2 with
the function body still stubbed; Task 3 TDDs the body.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

---

## Task 3 — TDD the skeleton body

Now we drive the 9-step skeleton from spec §3.3 via tests. Each test in this task corresponds to one A5 bullet; we add tests one-by-one, watch them fail, then implement just enough body to make them pass.

**Files:**
- Create: `vnext/packages/chat-flow-kit/src/serve-template.test.ts`
- Modify: `vnext/packages/chat-flow-kit/src/serve-template.ts` (replace stub body with real implementation)

### Test helper preamble (used by every test below)

Before the first test, the test file needs a tiny set of helpers. Land them in Step 1 so subsequent tests can reuse them.

- [ ] **Step 1: Create `serve-template.test.ts` with shared fixtures**

Write `vnext/packages/chat-flow-kit/src/serve-template.test.ts`:

```ts
// vnext/packages/chat-flow-kit/src/serve-template.test.ts
/**
 * Kit-level unit suite for serveTemplate. Covers Spec 10 §A5:
 *   - skeleton order (parse → preProcess → quotaGate → attempt → respond)
 *   - parse error path (default jsonErrorWrap vs parseErrorRender override)
 *   - preProcess short-circuit (no quota, no attempt, no respond)
 *   - preProcess continue + payload mutation visible to attempt
 *   - quota-gate short-circuit (no attempt invoked)
 *   - AbortController linking (downstream signal abort propagates)
 *   - respond receives final payload + extra
 *
 * Tests use bare in-memory fakes — no Hono / no LLM packages — because
 * the kit is domain-neutral.
 */
import { describe, expect, test } from 'bun:test'
import {
  serveTemplate,
  type KitAuthCtx,
  type PreProcessResult,
  type ServeTemplateDeps,
  type ServeTemplateHooks,
  type ServeTemplateInput,
} from './serve-template.ts'

type Auth = KitAuthCtx & { readonly userId?: string }
type Payload = { value: number; stream?: boolean }
type Extra = { tag: string } | undefined
type AttemptResult = { kind: 'ok'; echoed: number }
type TCtx = { tag: string; isStreaming: boolean }

// Default deps: quota allows, jsonErrorWrap echoes status + body,
// buildTelemetryCtx echoes endpointTag + stream flag. Tests override
// per-case via `{ ...defaultDeps(), runQuotaGate: ... }`.
function defaultDeps(overrides: Partial<ServeTemplateDeps<Auth, TCtx>> = {}): ServeTemplateDeps<Auth, TCtx> {
  return {
    runQuotaGate: async () => null,
    jsonErrorWrap: (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    buildTelemetryCtx: ({ endpointTag, isStreaming }) => ({ tag: endpointTag, isStreaming }),
    ...overrides,
  }
}

function defaultInput(overrides: Partial<ServeTemplateInput<Auth>> = {}): ServeTemplateInput<Auth> {
  return {
    raw: { value: 1 },
    auth: { apiKeyId: 'k1', userId: 'u1' },
    obsCtx: { apiKeyId: 'k1', userAgent: null, requestId: 'r1' },
    extras: {},
    ...overrides,
  }
}

function defaultHooks(
  overrides: Partial<ServeTemplateHooks<Payload, AttemptResult, Extra, Auth, TCtx>> = {},
): ServeTemplateHooks<Payload, AttemptResult, Extra, Auth, TCtx> {
  return {
    endpointTag: 'test_endpoint',
    parse: ({ raw }) => raw as Payload,
    wantsStream: (p) => p.stream === true,
    runAttempt: async (a) => ({ kind: 'ok', echoed: a.payload.value }),
    respond: async (r) => new Response(JSON.stringify(r), { status: 200 }),
    ...overrides,
  }
}
```

- [ ] **Step 2: Run the empty test file — expect 0 tests, exit 0**

Run from `vnext/packages/chat-flow-kit/`:

```
bun test src/serve-template.test.ts
```

Expected: `0 tests` reported, exit code 0. Confirms imports + helpers compile.

### A5 bullet 1 — Skeleton order

- [ ] **Step 3: Add failing test for skeleton order**

Append to `serve-template.test.ts`:

```ts
describe('serveTemplate — skeleton order', () => {
  test('runs parse → preProcess → buildTelemetryCtx → runQuotaGate → runAttempt → respond in order', async () => {
    const calls: string[] = []
    const hooks = defaultHooks({
      parse: ({ raw }) => {
        calls.push('parse')
        return raw as Payload
      },
      preProcess: async (payload) => {
        calls.push('preProcess')
        return { kind: 'continue', payload, extra: { tag: 'x' } }
      },
      wantsStream: (p) => {
        calls.push('wantsStream')
        return p.stream === true
      },
      runAttempt: async (a) => {
        calls.push('runAttempt')
        return { kind: 'ok', echoed: a.payload.value }
      },
      respond: async (r) => {
        calls.push('respond')
        return new Response(JSON.stringify(r), { status: 200 })
      },
    })
    const deps = defaultDeps({
      buildTelemetryCtx: ({ endpointTag, isStreaming }) => {
        calls.push('buildTelemetryCtx')
        return { tag: endpointTag, isStreaming }
      },
      runQuotaGate: async () => {
        calls.push('runQuotaGate')
        return null
      },
    })
    const result = await serveTemplate(hooks, defaultInput(), deps)
    expect(result.response.status).toBe(200)
    expect(calls).toEqual([
      'parse',
      'preProcess',
      'wantsStream',
      'buildTelemetryCtx',
      'runQuotaGate',
      'runAttempt',
      'respond',
    ])
  })
})
```

- [ ] **Step 4: Run — expect failure (stub throws)**

```
bun test src/serve-template.test.ts
```

Expected: 1 fail with `serveTemplate: not implemented`.

- [ ] **Step 5: Implement body to satisfy ordering test**

Replace the stub `serveTemplate` body in `vnext/packages/chat-flow-kit/src/serve-template.ts` with:

```ts
export async function serveTemplate<
  TPayload,
  TAttemptResult,
  TExtra = undefined,
  TAuth extends KitAuthCtx = KitAuthCtx,
  TTelemetryCtx = unknown,
>(
  hooks: ServeTemplateHooks<TPayload, TAttemptResult, TExtra, TAuth, TTelemetryCtx>,
  input: ServeTemplateInput<TAuth>,
  deps: ServeTemplateDeps<TAuth, TTelemetryCtx>,
): Promise<ServeTemplateResult<TExtra>> {
  const requestStartedAt = Date.now()

  // 1. Parse.
  let payload: TPayload
  try {
    payload = await hooks.parse(input)
  } catch (err) {
    const e = err as Error & { status?: number; body?: unknown }
    const render = hooks.parseErrorRender ?? ((x: typeof e) => deps.jsonErrorWrap(x.status ?? 400, x.body ?? { error: { message: x.message } }))
    return { response: render(e), extra: undefined }
  }

  // 2. preProcess (optional).
  let extra: TExtra | undefined
  if (hooks.preProcess) {
    let pre: PreProcessResult<TPayload, TExtra>
    try {
      pre = await hooks.preProcess(payload, { auth: input.auth })
    } catch (err) {
      const e = err as Error & { status?: number; body?: unknown }
      return {
        response: deps.jsonErrorWrap(e.status ?? 400, e.body ?? { error: { message: e.message } }),
        extra: undefined,
      }
    }
    if (pre.kind === 'short-circuit') {
      return { response: pre.response, extra: pre.extra }
    }
    payload = pre.payload
    extra = pre.extra
  }

  // 3. wantsStream.
  const wantsStream = hooks.wantsStream(payload, input)

  // 4. buildTelemetryCtx.
  const telemetryCtx = deps.buildTelemetryCtx({
    auth: input.auth,
    obsCtx: input.obsCtx,
    isStreaming: wantsStream,
    requestStartedAt,
    endpointTag: hooks.endpointTag,
  })

  // 5. quota gate.
  const quotaResp = await deps.runQuotaGate(input.auth.apiKeyId)
  if (quotaResp) return { response: quotaResp, extra }

  // 6. Linked AbortController.
  const controller = new AbortController()
  if (input.signal) {
    if (input.signal.aborted) controller.abort()
    else input.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  // 7. runAttempt.
  const result = await hooks.runAttempt({
    payload,
    auth: input.auth,
    telemetryCtx,
    downstreamAbortSignal: controller.signal,
    requestStartedAt,
    extras: input.extras,
  })

  // 8. respond.
  const response = await hooks.respond(result, {
    payload,
    extra: extra as TExtra,
    wantsStream,
    downstreamAbortController: controller,
    telemetryCtx,
    extras: input.extras,
  })

  // 9. return.
  return { response, extra }
}
```

- [ ] **Step 6: Run — expect pass**

```
bun test src/serve-template.test.ts
```

Expected: 1 pass.

- [ ] **Step 7: Commit**

```
cd vnext
git add packages/chat-flow-kit
git commit -m "feat(vnext/chat-flow-kit): TDD serveTemplate skeleton order

Spec 10 Part 1 Task 3 — first A5 bullet. Establishes the 9-step
skeleton from spec §3.3.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

### A5 bullet 2 — Parse error path (default + override)

- [ ] **Step 8: Add failing test for parse error → default jsonErrorWrap**

Append to `serve-template.test.ts`:

```ts
describe('serveTemplate — parse error path', () => {
  test('default: parse() throw → deps.jsonErrorWrap with status+body', async () => {
    const hooks = defaultHooks({
      parse: () => {
        const e = Object.assign(new Error('bad json'), {
          status: 422,
          body: { error: { type: 'invalid_request_error', message: 'bad json' } },
        })
        throw e
      },
    })
    const result = await serveTemplate(hooks, defaultInput(), defaultDeps())
    expect(result.response.status).toBe(422)
    expect(result.extra).toBeUndefined()
    expect(await result.response.json()).toEqual({
      error: { type: 'invalid_request_error', message: 'bad json' },
    })
  })

  test('default: parse() throws plain Error → 400 + message fallback', async () => {
    const hooks = defaultHooks({
      parse: () => {
        throw new Error('nope')
      },
    })
    const result = await serveTemplate(hooks, defaultInput(), defaultDeps())
    expect(result.response.status).toBe(400)
    expect(await result.response.json()).toEqual({ error: { message: 'nope' } })
  })

  test('parseErrorRender override is preferred over jsonErrorWrap', async () => {
    const calls: string[] = []
    const hooks = defaultHooks({
      parse: () => {
        throw Object.assign(new Error('x'), { status: 418, body: { teapot: true } })
      },
      parseErrorRender: (e) => {
        calls.push(`render:${e.status}`)
        return new Response('teapot', { status: 418, headers: { 'x-render': 'custom' } })
      },
    })
    const deps = defaultDeps({
      jsonErrorWrap: () => {
        throw new Error('jsonErrorWrap must NOT be called when parseErrorRender provided')
      },
    })
    const result = await serveTemplate(hooks, defaultInput(), deps)
    expect(result.response.status).toBe(418)
    expect(result.response.headers.get('x-render')).toBe('custom')
    expect(await result.response.text()).toBe('teapot')
    expect(calls).toEqual(['render:418'])
  })
})
```

- [ ] **Step 9: Run — expect all 3 new tests to pass**

The body from Step 5 already implements both branches. Run:

```
bun test src/serve-template.test.ts
```

Expected: 4 pass total (1 from earlier + 3 new). If any fails, fix the body — do NOT change the test.

- [ ] **Step 10: Commit**

```
cd vnext
git add packages/chat-flow-kit/src/serve-template.test.ts
git commit -m "test(vnext/chat-flow-kit): cover parse-error path (default + override)

Spec 10 Part 1 Task 3 — A5 bullet 2.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

### A5 bullet 3 — preProcess short-circuit

- [ ] **Step 11: Add failing test for short-circuit branch**

Append to `serve-template.test.ts`:

```ts
describe('serveTemplate — preProcess short-circuit', () => {
  test('short-circuit returns the supplied Response and skips quota/attempt/respond', async () => {
    const calls: string[] = []
    const hooks = defaultHooks({
      preProcess: async () => {
        calls.push('preProcess')
        return {
          kind: 'short-circuit',
          response: new Response('blocked', { status: 451, headers: { 'x-from': 'pre' } }),
          extra: { tag: 'sc' },
        }
      },
      runAttempt: async () => {
        calls.push('runAttempt')
        return { kind: 'ok', echoed: -1 }
      },
      respond: async () => {
        calls.push('respond')
        return new Response('should not happen', { status: 500 })
      },
    })
    const deps = defaultDeps({
      runQuotaGate: async () => {
        calls.push('runQuotaGate')
        return null
      },
    })
    const result = await serveTemplate(hooks, defaultInput(), deps)
    expect(result.response.status).toBe(451)
    expect(result.response.headers.get('x-from')).toBe('pre')
    expect(await result.response.text()).toBe('blocked')
    expect(result.extra).toEqual({ tag: 'sc' })
    expect(calls).toEqual(['preProcess'])
  })

  test('preProcess throw with status+body uses jsonErrorWrap', async () => {
    const hooks = defaultHooks({
      preProcess: async () => {
        throw Object.assign(new Error('pre-bad'), {
          status: 409,
          body: { error: { message: 'conflict' } },
        })
      },
    })
    const result = await serveTemplate(hooks, defaultInput(), defaultDeps())
    expect(result.response.status).toBe(409)
    expect(await result.response.json()).toEqual({ error: { message: 'conflict' } })
    expect(result.extra).toBeUndefined()
  })
})
```

- [ ] **Step 12: Run — expect pass**

```
bun test src/serve-template.test.ts
```

Expected: 6 pass total.

- [ ] **Step 13: Commit**

```
cd vnext
git add packages/chat-flow-kit/src/serve-template.test.ts
git commit -m "test(vnext/chat-flow-kit): cover preProcess short-circuit + throw paths

Spec 10 Part 1 Task 3 — A5 bullet 3.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

### A5 bullet 4 — preProcess continue + payload mutation

- [ ] **Step 14: Add failing test for continue + mutation**

Append to `serve-template.test.ts`:

```ts
describe('serveTemplate — preProcess continue + mutation', () => {
  test('mutated payload is what runAttempt + respond see', async () => {
    const seenByAttempt: Payload[] = []
    const seenByRespond: Payload[] = []
    const hooks = defaultHooks({
      preProcess: async (payload) => ({
        kind: 'continue',
        payload: { ...payload, value: payload.value + 100 },
        extra: { tag: 'mutated' },
      }),
      runAttempt: async (a) => {
        seenByAttempt.push(a.payload)
        return { kind: 'ok', echoed: a.payload.value }
      },
      respond: async (r, c) => {
        seenByRespond.push(c.payload)
        return new Response(JSON.stringify({ r, extra: c.extra }), { status: 200 })
      },
    })
    const result = await serveTemplate(hooks, defaultInput({ raw: { value: 7 } }), defaultDeps())
    expect(seenByAttempt).toEqual([{ value: 107 }])
    expect(seenByRespond).toEqual([{ value: 107 }])
    expect(result.extra).toEqual({ tag: 'mutated' })
    const body = await result.response.json()
    expect(body).toEqual({ r: { kind: 'ok', echoed: 107 }, extra: { tag: 'mutated' } })
  })
})
```

- [ ] **Step 15: Run — expect pass**

```
bun test src/serve-template.test.ts
```

Expected: 7 pass total.

- [ ] **Step 16: Commit**

```
cd vnext
git add packages/chat-flow-kit/src/serve-template.test.ts
git commit -m "test(vnext/chat-flow-kit): cover preProcess continue + payload mutation

Spec 10 Part 1 Task 3 — A5 bullet 4.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

### A5 bullet 5 — Quota-gate short-circuit

- [ ] **Step 17: Add failing test for quota → 429 short-circuit**

Append to `serve-template.test.ts`:

```ts
describe('serveTemplate — quota-gate short-circuit', () => {
  test('quota Response returns immediately; runAttempt + respond not invoked', async () => {
    const calls: string[] = []
    const hooks = defaultHooks({
      preProcess: async (p) => {
        calls.push('preProcess')
        return { kind: 'continue', payload: p, extra: { tag: 'q' } }
      },
      runAttempt: async () => {
        calls.push('runAttempt')
        return { kind: 'ok', echoed: -1 }
      },
      respond: async () => {
        calls.push('respond')
        return new Response('should not happen', { status: 500 })
      },
    })
    const deps = defaultDeps({
      runQuotaGate: async (apiKeyId) => {
        calls.push(`runQuotaGate:${apiKeyId}`)
        return new Response(JSON.stringify({ error: { type: 'rate_limit_error' } }), { status: 429 })
      },
    })
    const result = await serveTemplate(hooks, defaultInput(), deps)
    expect(result.response.status).toBe(429)
    expect(await result.response.json()).toEqual({ error: { type: 'rate_limit_error' } })
    expect(result.extra).toEqual({ tag: 'q' })
    expect(calls).toEqual(['preProcess', 'runQuotaGate:k1'])
  })
})
```

- [ ] **Step 18: Run — expect pass**

```
bun test src/serve-template.test.ts
```

Expected: 8 pass total.

- [ ] **Step 19: Commit**

```
cd vnext
git add packages/chat-flow-kit/src/serve-template.test.ts
git commit -m "test(vnext/chat-flow-kit): cover quota-gate short-circuit

Spec 10 Part 1 Task 3 — A5 bullet 5.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

### A5 bullet 6 — AbortController linking

- [ ] **Step 20: Add failing test for inbound-signal-aborts-controller**

Append to `serve-template.test.ts`:

```ts
describe('serveTemplate — AbortController linking', () => {
  test('inbound signal abort fires the downstream signal observed by runAttempt', async () => {
    const inbound = new AbortController()
    let observedSignal: AbortSignal | undefined
    let abortedDuringAttempt = false
    const hooks = defaultHooks({
      runAttempt: async (a) => {
        observedSignal = a.downstreamAbortSignal
        // Abort inbound mid-attempt; the linked controller should propagate.
        inbound.abort()
        // Microtask flush so the event listener fires before we read.
        await Promise.resolve()
        abortedDuringAttempt = a.downstreamAbortSignal.aborted
        return { kind: 'ok', echoed: a.payload.value }
      },
    })
    await serveTemplate(hooks, defaultInput({ signal: inbound.signal }), defaultDeps())
    expect(observedSignal).toBeDefined()
    expect(abortedDuringAttempt).toBe(true)
  })

  test('already-aborted inbound signal yields an already-aborted downstream signal', async () => {
    const inbound = new AbortController()
    inbound.abort()
    let downstreamAbortedAtAttempt = false
    const hooks = defaultHooks({
      runAttempt: async (a) => {
        downstreamAbortedAtAttempt = a.downstreamAbortSignal.aborted
        return { kind: 'ok', echoed: a.payload.value }
      },
    })
    await serveTemplate(hooks, defaultInput({ signal: inbound.signal }), defaultDeps())
    expect(downstreamAbortedAtAttempt).toBe(true)
  })

  test('respond receives the same AbortController instance as runAttempt', async () => {
    let attemptSignal: AbortSignal | undefined
    let respondController: AbortController | undefined
    const hooks = defaultHooks({
      runAttempt: async (a) => {
        attemptSignal = a.downstreamAbortSignal
        return { kind: 'ok', echoed: a.payload.value }
      },
      respond: async (r, c) => {
        respondController = c.downstreamAbortController
        return new Response(JSON.stringify(r), { status: 200 })
      },
    })
    await serveTemplate(hooks, defaultInput(), defaultDeps())
    expect(respondController).toBeDefined()
    expect(respondController!.signal).toBe(attemptSignal)
  })
})
```

- [ ] **Step 21: Run — expect pass**

```
bun test src/serve-template.test.ts
```

Expected: 11 pass total.

- [ ] **Step 22: Commit**

```
cd vnext
git add packages/chat-flow-kit/src/serve-template.test.ts
git commit -m "test(vnext/chat-flow-kit): cover AbortController linking (both directions)

Spec 10 Part 1 Task 3 — A5 bullet 6.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

### A5 bullet 7 — Respond receives payload + extra + telemetryCtx

- [ ] **Step 23: Add failing test for respond ctx**

Append to `serve-template.test.ts`:

```ts
describe('serveTemplate — respond ctx', () => {
  test('respond receives the final payload, extra from preProcess, wantsStream, telemetryCtx, extras', async () => {
    let observed: {
      payload?: Payload
      extra?: Extra
      wantsStream?: boolean
      telemetryCtx?: TCtx
      extras?: Record<string, unknown>
    } = {}
    const hooks = defaultHooks({
      preProcess: async (p) => ({
        kind: 'continue',
        payload: { ...p, value: p.value * 2 },
        extra: { tag: 'observed' },
      }),
      wantsStream: () => true,
      respond: async (_r, c) => {
        observed = {
          payload: c.payload,
          extra: c.extra,
          wantsStream: c.wantsStream,
          telemetryCtx: c.telemetryCtx,
          extras: c.extras,
        }
        return new Response('ok', { status: 200 })
      },
    })
    await serveTemplate(
      hooks,
      defaultInput({ raw: { value: 5, stream: true }, extras: { side: 'channel' } }),
      defaultDeps(),
    )
    expect(observed.payload).toEqual({ value: 10, stream: true })
    expect(observed.extra).toEqual({ tag: 'observed' })
    expect(observed.wantsStream).toBe(true)
    expect(observed.telemetryCtx).toEqual({ tag: 'test_endpoint', isStreaming: true })
    expect(observed.extras).toEqual({ side: 'channel' })
  })

  test('without preProcess, extra defaults to undefined', async () => {
    let observedExtra: Extra | 'unset' = 'unset'
    const hooks = defaultHooks({
      respond: async (_r, c) => {
        observedExtra = c.extra
        return new Response('ok', { status: 200 })
      },
    })
    const result = await serveTemplate(hooks, defaultInput(), defaultDeps())
    expect(observedExtra).toBeUndefined()
    expect(result.extra).toBeUndefined()
  })
})
```

- [ ] **Step 24: Run — expect pass**

```
bun test src/serve-template.test.ts
```

Expected: 13 pass total.

- [ ] **Step 25: Commit**

```
cd vnext
git add packages/chat-flow-kit/src/serve-template.test.ts
git commit -m "test(vnext/chat-flow-kit): cover respond ctx (payload, extra, telemetry, extras)

Spec 10 Part 1 Task 3 — A5 bullet 7 (final).

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

---

## Task 4 — Acceptance gates for Part 1

- [ ] **Step 1: Typecheck the kit**

Run from `vnext/`:

```
bun --filter '@vnext-gateway/chat-flow-kit' run typecheck
```

Expected: PASS.

- [ ] **Step 2: Framework-purity scan**

Run from `vnext/`:

```
bun run scripts/check-framework-purity.ts
```

Expected: PASS. Confirms A3 (no `@vnext-llm/*` imports). The kit ships zero LLM literals because the four endpoint tag strings live in adapter code (Parts 2–4), not in the kit.

- [ ] **Step 3: Manual literal scan inside the kit**

Run from `vnext/`:

```
grep -rE "(chat_completions|messages|responses|gemini|Copilot|Anthropic|OpenAI)" packages/chat-flow-kit/src
```

Expected: NO matches. If anything appears, remove it before moving on.

- [ ] **Step 4: Full kit test run**

Run from `vnext/`:

```
bun test packages/chat-flow-kit
```

Expected: 13 pass, 0 fail.

- [ ] **Step 5: Workspace-wide test sanity (no regressions)**

Run from `vnext/`:

```
bun test
```

Expected: full suite still passes. Part 1 changes only added a new isolated package; no existing tests touch it.

- [ ] **Step 6: Final commit (no-op if nothing changed)**

If steps 1–5 surfaced any fix, commit it separately. Otherwise skip.

---

## Self-Review

Run this checklist before handing Part 1 to a subagent.

1. **Spec coverage (Part 1 only):**
   - §3.1 hook types declared in Task 2 ✓
   - §3.2 deps types declared in Task 2 ✓
   - §3.3 9-step skeleton implemented in Task 3 Step 5 ✓
   - A5 unit suite — 7 bullets each have a `describe` block in Task 3 ✓
   - A3 purity check passes (Task 4 Step 2/3) ✓
   - Parts 2–4 cover A1, A2, A4, A6, A7 — explicitly out of scope here ✓

2. **Placeholder scan:** No TBD/TODO/"implement later"/"similar to" patterns. Every code step has a complete code block. Every test step has the exact assertions.

3. **Type consistency:**
   - `KitAuthCtx` declared in Task 2; test fixtures extend it as `Auth = KitAuthCtx & { userId? }` in Task 3 Step 1. ✓
   - `serveTemplate` generics order `<TPayload, TAttemptResult, TExtra, TAuth, TTelemetryCtx>` matches between hooks declaration (Task 2) and function declaration (Task 2/3). ✓
   - `ServeTemplateDeps<TAuth, TTelemetryCtx>` order is consistent across declaration (Task 2) and `defaultDeps` (Task 3 Step 1). ✓
   - `buildTelemetryCtx` input shape (`{ auth, obsCtx, isStreaming, requestStartedAt, endpointTag }`) matches between declaration (Task 2), the call site in `serveTemplate` (Task 3 Step 5), and the test fake (Task 3 Step 1). ✓
   - `RespondCtx` field set (`payload, extra, wantsStream, downstreamAbortController, telemetryCtx, extras`) consistent across declaration, call site, and the `respond ctx` test (Task 3 Step 23). ✓

---

**End of Part 1.** Next: Part 2 — wire `kitDeps` in gateway, migrate chat-completions.
