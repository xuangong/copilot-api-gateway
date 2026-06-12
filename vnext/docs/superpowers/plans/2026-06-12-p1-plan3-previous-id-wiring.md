# P1 Plan 3 — `previous_response_id` Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the P1 Plan 1 `responses-store` package into the `/v1/responses` route so that gateway transparently expands `previous_response_id` into prior-turn input/output items before pair selection, and persists each turn's snapshot after the response is finalized — making multi-turn `responses` work uniformly across hub-anchored translator pairs.

**Architecture:** A new dispatch bridge module exposes two pure functions: `expandPreviousResponseId` (mutates payload in place: prepends snapshot items to `input`, deletes `previous_response_id`) and `savePostTurnSnapshot` (writes the merged input+output items keyed by upstream `response.id`). The `/v1/responses` route calls expand right after `parseResponsesPayload`, then on stream completion or non-stream JSON it calls save. A new `PreviousResponseNotFoundError` flows through `errors/repackage.ts` as a verbatim OpenAI 400 envelope with `code: previous_response_not_found`. The store is provisioned via `Env.responsesStore` — Cloudflare Workers binds a `SqliteResponsesSnapshotStore` over the existing D1 database; local Bun binds the same class over `bun:sqlite` (delegated through the same driver shim Plan 1 introduced). Apart from the route changes and `Env` field, nothing else in the dispatch pipeline moves; pair selection, translator registry, and observability all keep their pre-P1 contracts.

**Tech Stack:** Bun + Hono + Cloudflare Workers + D1 (SQLite), TypeScript, Vitest/`bun:test`, the openai-node SDK for the multi-turn integration test.

**Depends on:** P1 Plan 1 (`@vnext/responses-store` package shipped) and P1 Plan 2 (chat↔responses translator pair registered). This plan is a pure consumer of both — no edits inside `packages/responses-store/` or `packages/translate/` are required.

---

## File Structure

| File | Role |
|------|------|
| `vnext/apps/gateway/src/data-plane/dispatch/responses-store-bridge.ts` | New. Houses `PreviousResponseNotFoundError`, `expandPreviousResponseId`, `savePostTurnSnapshot`. Pure async functions; the only stateful collaborator is the injected `ResponsesSnapshotStore`. |
| `vnext/apps/gateway/src/data-plane/errors/repackage.ts` | Modify. Add a thin overload that accepts `PreviousResponseNotFoundError` and renders the verbatim OpenAI 400 envelope. |
| `vnext/apps/gateway/src/data-plane/routes.ts` | Modify. Only the `/v1/responses` POST handler. Call `expandPreviousResponseId` between `parseResponsesPayload` and `dispatch(...)`; after `dispatch` returns, intercept stream/body to call `savePostTurnSnapshot`. |
| `vnext/apps/gateway/src/app.ts` | Modify. Add `responsesStore?: ResponsesSnapshotStore` to `Env`; provision per-runtime in `buildApp` (or equivalent factory). |
| `vnext/apps/gateway/src/shared/runtime/responses-store-factory.ts` | New. Tiny per-runtime factory: `createResponsesSnapshotStore({ d1?, sqlite? })` returns the right `SqliteResponsesSnapshotStore` instance. |
| `vnext/apps/gateway/tests/dispatch/responses-store-bridge.test.ts` | New. Unit tests for `expandPreviousResponseId` and `savePostTurnSnapshot` against `InMemoryResponsesSnapshotStore`. |
| `vnext/apps/gateway/tests/responses-previous-id.e2e.test.ts` | New. End-to-end against the Hono app: turn 1 → snapshot saved, turn 2 with `previous_response_id` → expansion, turn 3 with unknown id → 400 envelope, turn 4 with mismatched `apiKeyId` → 400 envelope. |
| `tests/sdk-openai-responses-multi-turn.test.ts` | New. Real `openai` SDK against a chat-backed model and a responses-backed model — both must complete a `previous_response_id` follow-up. |

---

## Conventions

- All new files start with a 2-3 line module doc comment explaining purpose, mirroring existing dispatch siblings.
- `expandPreviousResponseId` mutates the payload in place — same convention as `parseResponsesPayload` (Zod returns the validated object; downstream code treats it as mutable through the dispatch pipeline). The mutation is local: prepend to `payload.input`, delete `payload.previous_response_id`. Anything else stays untouched.
- `savePostTurnSnapshot` is fire-and-forget from the route's perspective: failures log via `console.warn` but do not break the response. Rationale matches the spec's "at-least-once" stance — D1 is eventually consistent so a brief save outage degrades gracefully rather than failing the user request.
- Tests reuse `setRepoForTest` and the `installFetch` helper already established in `vnext/apps/gateway/tests/responses.e2e.test.ts`; do not invent a new harness.
- The OpenAI 400 envelope literal (matching Floway's verbatim capture):
  ```json
  {"error":{"message":"Previous response with id '<id>' not found.","type":"invalid_request_error","param":"previous_response_id","code":"previous_response_not_found"}}
  ```

---

## Task 1: Scaffold `responses-store-bridge.ts` with the error class and signatures

**Files:**
- Create: `vnext/apps/gateway/src/data-plane/dispatch/responses-store-bridge.ts`
- Test: `vnext/apps/gateway/tests/dispatch/responses-store-bridge.test.ts`

- [ ] **Step 1: Write the failing test for `PreviousResponseNotFoundError` shape**

```ts
// vnext/apps/gateway/tests/dispatch/responses-store-bridge.test.ts
import { test, expect } from 'bun:test'
import { PreviousResponseNotFoundError } from '../../src/data-plane/dispatch/responses-store-bridge.ts'

test('PreviousResponseNotFoundError carries id and 400 status', () => {
  const err = new PreviousResponseNotFoundError('resp_abc')
  expect(err).toBeInstanceOf(Error)
  expect(err.responseId).toBe('resp_abc')
  expect(err.status).toBe(400)
  expect(err.message).toBe("Previous response with id 'resp_abc' not found.")
})
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `bun test vnext/apps/gateway/tests/dispatch/responses-store-bridge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the bridge module with the error class and function signatures (no logic yet)**

```ts
// vnext/apps/gateway/src/data-plane/dispatch/responses-store-bridge.ts
/**
 * Bridge between /v1/responses dispatch and the responses-snapshot store.
 *
 * `expandPreviousResponseId` mutates the inbound payload in place: when
 * `previous_response_id` is present, load the matching snapshot, prepend its
 * `items` to `payload.input`, and drop the field so the upstream call never
 * sees it. `savePostTurnSnapshot` is the post-turn writer.
 */
import type { ResponsesSnapshotStore } from '@vnext/responses-store'

export class PreviousResponseNotFoundError extends Error {
  readonly status = 400
  constructor(readonly responseId: string) {
    super(`Previous response with id '${responseId}' not found.`)
    this.name = 'PreviousResponseNotFoundError'
  }
}

export async function expandPreviousResponseId(
  payload: { previous_response_id?: string | null; input?: unknown },
  store: ResponsesSnapshotStore,
  apiKeyId: string | null,
): Promise<void> {
  void payload
  void store
  void apiKeyId
  throw new Error('not implemented')
}

export async function savePostTurnSnapshot(
  store: ResponsesSnapshotStore,
  args: {
    responseId: string
    apiKeyId: string | null
    model: string
    inputItems: unknown[]
    outputItems: unknown[]
  },
): Promise<void> {
  void store
  void args
  throw new Error('not implemented')
}
```

- [ ] **Step 4: Run test, confirm it passes**

Run: `bun test vnext/apps/gateway/tests/dispatch/responses-store-bridge.test.ts`
Expected: PASS (only the error-shape test runs).

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/dispatch/responses-store-bridge.ts \
        vnext/apps/gateway/tests/dispatch/responses-store-bridge.test.ts
git commit -m "feat(gateway/dispatch): scaffold responses-store-bridge"
```

---

## Task 2: Implement `expandPreviousResponseId`

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/dispatch/responses-store-bridge.ts`
- Test: `vnext/apps/gateway/tests/dispatch/responses-store-bridge.test.ts`

- [ ] **Step 1: Write failing tests for the four expansion cases**

```ts
import { InMemoryResponsesSnapshotStore } from '@vnext/responses-store'
import { expandPreviousResponseId, PreviousResponseNotFoundError } from '../../src/data-plane/dispatch/responses-store-bridge.ts'

test('expand: no previous_response_id is a no-op', async () => {
  const store = new InMemoryResponsesSnapshotStore()
  const payload: { input?: unknown[]; previous_response_id?: string | null } = {
    input: [{ type: 'message', role: 'user', content: 'hi' }],
  }
  await expandPreviousResponseId(payload, store, 'k1')
  expect(payload.input).toEqual([{ type: 'message', role: 'user', content: 'hi' }])
  expect(payload.previous_response_id).toBeUndefined()
})

test('expand: hit prepends snapshot items and deletes the field', async () => {
  const store = new InMemoryResponsesSnapshotStore()
  await store.save({
    responseId: 'resp_1',
    apiKeyId: 'k1',
    model: 'gpt-x',
    items: [
      { type: 'message', role: 'user', content: 'turn1 user' },
      { type: 'message', role: 'assistant', content: 'turn1 assistant' },
    ],
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  })
  const payload: { input?: unknown[]; previous_response_id?: string | null } = {
    previous_response_id: 'resp_1',
    input: [{ type: 'message', role: 'user', content: 'turn2 user' }],
  }
  await expandPreviousResponseId(payload, store, 'k1')
  expect(payload.previous_response_id).toBeUndefined()
  expect(payload.input).toEqual([
    { type: 'message', role: 'user', content: 'turn1 user' },
    { type: 'message', role: 'assistant', content: 'turn1 assistant' },
    { type: 'message', role: 'user', content: 'turn2 user' },
  ])
})

test('expand: missing input is treated as empty array', async () => {
  const store = new InMemoryResponsesSnapshotStore()
  await store.save({
    responseId: 'resp_2',
    apiKeyId: null,
    model: 'gpt-x',
    items: [{ type: 'message', role: 'user', content: 'old' }],
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  })
  const payload: { input?: unknown[]; previous_response_id?: string | null } = {
    previous_response_id: 'resp_2',
  }
  await expandPreviousResponseId(payload, store, null)
  expect(payload.input).toEqual([{ type: 'message', role: 'user', content: 'old' }])
})

test('expand: unknown id throws PreviousResponseNotFoundError', async () => {
  const store = new InMemoryResponsesSnapshotStore()
  const payload = { previous_response_id: 'resp_missing' }
  await expect(expandPreviousResponseId(payload, store, 'k1'))
    .rejects.toBeInstanceOf(PreviousResponseNotFoundError)
})

test('expand: snapshot owned by another api key is not visible', async () => {
  const store = new InMemoryResponsesSnapshotStore()
  await store.save({
    responseId: 'resp_owned',
    apiKeyId: 'k_other',
    model: 'gpt-x',
    items: [{ type: 'message', role: 'user', content: 'secret' }],
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  })
  const payload = { previous_response_id: 'resp_owned' }
  await expect(expandPreviousResponseId(payload, store, 'k1'))
    .rejects.toBeInstanceOf(PreviousResponseNotFoundError)
})
```

- [ ] **Step 2: Run tests, confirm they fail with "not implemented"**

Run: `bun test vnext/apps/gateway/tests/dispatch/responses-store-bridge.test.ts`
Expected: FAIL — five new failures.

- [ ] **Step 3: Implement `expandPreviousResponseId`**

Replace the body in `responses-store-bridge.ts`:

```ts
export async function expandPreviousResponseId(
  payload: { previous_response_id?: string | null; input?: unknown },
  store: ResponsesSnapshotStore,
  apiKeyId: string | null,
): Promise<void> {
  const id = payload.previous_response_id
  if (id == null || id === '') return
  const snap = await store.load(id, apiKeyId)
  if (!snap) throw new PreviousResponseNotFoundError(id)
  const existing = Array.isArray(payload.input) ? (payload.input as unknown[]) : []
  payload.input = [...snap.items, ...existing]
  delete payload.previous_response_id
}
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `bun test vnext/apps/gateway/tests/dispatch/responses-store-bridge.test.ts`
Expected: PASS — six tests (one error-shape, five expand).

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/dispatch/responses-store-bridge.ts \
        vnext/apps/gateway/tests/dispatch/responses-store-bridge.test.ts
git commit -m "feat(gateway/dispatch): expandPreviousResponseId hits + miss + ownership"
```

---

## Task 3: Implement `savePostTurnSnapshot`

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/dispatch/responses-store-bridge.ts`
- Test: `vnext/apps/gateway/tests/dispatch/responses-store-bridge.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { savePostTurnSnapshot } from '../../src/data-plane/dispatch/responses-store-bridge.ts'

test('save: writes merged input+output items keyed by responseId', async () => {
  const store = new InMemoryResponsesSnapshotStore()
  const inputItems = [{ type: 'message', role: 'user', content: 'in1' }]
  const outputItems = [{ type: 'message', role: 'assistant', content: 'out1' }]
  await savePostTurnSnapshot(store, {
    responseId: 'resp_save_1',
    apiKeyId: 'k1',
    model: 'gpt-x',
    inputItems,
    outputItems,
  })
  const got = await store.load('resp_save_1', 'k1')
  expect(got).not.toBeNull()
  expect(got!.items).toEqual([...inputItems, ...outputItems])
  expect(got!.model).toBe('gpt-x')
  expect(got!.apiKeyId).toBe('k1')
  expect(got!.expiresAt).toBeGreaterThan(got!.createdAt)
})

test('save: anonymous owner uses null apiKeyId', async () => {
  const store = new InMemoryResponsesSnapshotStore()
  await savePostTurnSnapshot(store, {
    responseId: 'resp_save_2',
    apiKeyId: null,
    model: 'gpt-x',
    inputItems: [],
    outputItems: [{ type: 'message', role: 'assistant', content: 'hi' }],
  })
  expect(await store.load('resp_save_2', null)).not.toBeNull()
  expect(await store.load('resp_save_2', 'k1')).toBeNull()
})
```

- [ ] **Step 2: Run, confirm fail**

Run: `bun test vnext/apps/gateway/tests/dispatch/responses-store-bridge.test.ts`
Expected: FAIL — "not implemented".

- [ ] **Step 3: Implement `savePostTurnSnapshot`**

```ts
const DEFAULT_TTL_MS = 24 * 3600_000

export async function savePostTurnSnapshot(
  store: ResponsesSnapshotStore,
  args: {
    responseId: string
    apiKeyId: string | null
    model: string
    inputItems: unknown[]
    outputItems: unknown[]
  },
): Promise<void> {
  const now = Date.now()
  await store.save({
    responseId: args.responseId,
    apiKeyId: args.apiKeyId,
    model: args.model,
    items: [...args.inputItems, ...args.outputItems],
    createdAt: now,
    expiresAt: now + DEFAULT_TTL_MS,
  })
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun test vnext/apps/gateway/tests/dispatch/responses-store-bridge.test.ts`
Expected: PASS — eight tests.

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/dispatch/responses-store-bridge.ts \
        vnext/apps/gateway/tests/dispatch/responses-store-bridge.test.ts
git commit -m "feat(gateway/dispatch): savePostTurnSnapshot persists merged items"
```

---

## Task 4: Render `PreviousResponseNotFoundError` as a verbatim 400 envelope

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/errors/repackage.ts`
- Test: `vnext/apps/gateway/tests/errors/repackage-previous-id.test.ts` (new)

- [ ] **Step 1: Write failing test for envelope shape**

```ts
// vnext/apps/gateway/tests/errors/repackage-previous-id.test.ts
import { test, expect } from 'bun:test'
import { PreviousResponseNotFoundError } from '../../src/data-plane/dispatch/responses-store-bridge.ts'
import { renderPreviousResponseNotFound } from '../../src/data-plane/errors/repackage.ts'

test('renderPreviousResponseNotFound emits OpenAI verbatim 400 envelope', async () => {
  const res = renderPreviousResponseNotFound(new PreviousResponseNotFoundError('resp_abc'))
  expect(res.status).toBe(400)
  expect(res.headers.get('content-type')).toContain('application/json')
  const body = await res.json() as { error: { message: string; type: string; param: string; code: string } }
  expect(body).toEqual({
    error: {
      message: "Previous response with id 'resp_abc' not found.",
      type: 'invalid_request_error',
      param: 'previous_response_id',
      code: 'previous_response_not_found',
    },
  })
})
```

- [ ] **Step 2: Run, confirm fail**

Run: `bun test vnext/apps/gateway/tests/errors/repackage-previous-id.test.ts`
Expected: FAIL — `renderPreviousResponseNotFound` does not exist.

- [ ] **Step 3: Add the renderer to `repackage.ts`**

Append to `vnext/apps/gateway/src/data-plane/errors/repackage.ts` (after the existing `repackageUpstreamError` function, before EOF — keep imports tidy):

```ts
import type { PreviousResponseNotFoundError } from '../dispatch/responses-store-bridge.ts'

/**
 * Render the responses snapshot miss as the OpenAI verbatim 400 envelope.
 * Kept separate from `repackageUpstreamError` because the "upstream" here is
 * gateway-side state (the snapshot store), not a remote 4xx body.
 */
export function renderPreviousResponseNotFound(err: PreviousResponseNotFoundError): Response {
  const body = {
    error: {
      message: err.message,
      type: 'invalid_request_error',
      param: 'previous_response_id',
      code: 'previous_response_not_found',
    },
  }
  return new Response(JSON.stringify(body), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  })
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun test vnext/apps/gateway/tests/errors/repackage-previous-id.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/errors/repackage.ts \
        vnext/apps/gateway/tests/errors/repackage-previous-id.test.ts
git commit -m "feat(gateway/errors): renderPreviousResponseNotFound verbatim 400 envelope"
```

---

## Task 5: Add the `Env.responsesStore` field and runtime factory

**Files:**
- Modify: `vnext/apps/gateway/src/app.ts`
- Create: `vnext/apps/gateway/src/shared/runtime/responses-store-factory.ts`

- [ ] **Step 1: Write the factory module**

```ts
// vnext/apps/gateway/src/shared/runtime/responses-store-factory.ts
/**
 * Per-runtime factory for the responses snapshot store.
 *
 * - On Cloudflare Workers, `env.DB` (D1Database) is wrapped in the D1 driver.
 * - On Bun (local dev/tests), an opened `bun:sqlite` Database is wrapped in
 *   the sqlite driver.
 *
 * Both paths produce a single `SqliteResponsesSnapshotStore`; the only thing
 * that differs is the underlying driver shim.
 */
import {
  SqliteResponsesSnapshotStore,
  type ResponsesSnapshotStore,
  d1Driver,
  bunSqliteDriver,
} from '@vnext/responses-store'

export function createD1ResponsesStore(db: D1Database): ResponsesSnapshotStore {
  return new SqliteResponsesSnapshotStore(d1Driver(db))
}

export function createBunResponsesStore(sqlite: import('bun:sqlite').Database): ResponsesSnapshotStore {
  return new SqliteResponsesSnapshotStore(bunSqliteDriver(sqlite))
}
```

- [ ] **Step 2: Add `responsesStore` to `Env` and a default-injection middleware in `app.ts`**

Modify `vnext/apps/gateway/src/app.ts`:

```ts
import { Hono } from 'hono'
import { dataPlane } from './data-plane/routes.ts'
import { controlPlane } from './control-plane/routes.ts'
import { staticPages } from './shared/edge/static-pages.ts'
import { getRepo } from './shared/repo/index.ts'
import { devAuthMiddleware } from './shared/dev-auth.ts'
import type { ResponsesSnapshotStore } from '@vnext/responses-store'
import { createD1ResponsesStore } from './shared/runtime/responses-store-factory.ts'

export interface Env {
  DB: D1Database
  KV: KVNamespace
  IMAGE_CACHE: KVNamespace
  IMAGES: ImagesBinding
  ACCOUNT_TYPE?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  /** Optional override (tests inject InMemoryResponsesSnapshotStore here). */
  responsesStore?: ResponsesSnapshotStore
}

export const app = new Hono<{ Bindings: Env }>()

app.get('/health', (c) => c.json({ status: 'ok', service: 'copilot-gateway-vnext' }))

app.get('/debug/db/users-count', async (c) => {
  const users = await getRepo().users.list()
  return c.json({ users: users.length })
})

app.use('*', async (c, next) => {
  if (!c.env.responsesStore && c.env.DB) {
    c.env.responsesStore = createD1ResponsesStore(c.env.DB)
  }
  await next()
})

app.use('*', devAuthMiddleware)

app.route('/', dataPlane)
app.route('/', controlPlane)
app.route('/', staticPages)
```

- [ ] **Step 3: Smoke-check the existing e2e suite still passes**

Run: `bun test vnext/apps/gateway/tests/responses.e2e.test.ts`
Expected: PASS — wiring change is backward-compatible because tests pass `c.env = {}` and never read `responsesStore`.

- [ ] **Step 4: Commit**

```bash
git add vnext/apps/gateway/src/app.ts \
        vnext/apps/gateway/src/shared/runtime/responses-store-factory.ts
git commit -m "feat(gateway): wire Env.responsesStore + per-runtime factory"
```

---

## Task 6: Inject `expandPreviousResponseId` into the `/v1/responses` route

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/routes.ts`

- [ ] **Step 1: Write failing e2e test for the expand path**

```ts
// vnext/apps/gateway/tests/responses-previous-id.e2e.test.ts
import { test, expect, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { app as innerApp } from '../src/app.ts'
import { setRepoForTest } from '../src/shared/repo/index.ts'
import type { Repo, UpstreamRecord } from '../src/shared/repo/types.ts'
import type { Model } from '@vnext/provider-copilot'
import type { DataPlaneAuthCtx } from '../src/data-plane/models/routes.ts'
import { InMemoryResponsesSnapshotStore } from '@vnext/responses-store'

const stubModel = (id: string): Model => ({
  id, object: 'model', name: id, vendor: 'openai', version: id,
  model_picker_enabled: true, preview: false,
  capabilities: {
    family: 'openai', limits: { max_context_window_tokens: 128000, max_output_tokens: 4096 },
    object: 'model_capabilities', supports: {}, tokenizer: 'cl100k', type: 'text',
  },
})

const stubUpstream = (): UpstreamRecord => ({
  id: 'copilot:u1', provider: 'copilot', name: 'u1', enabled: true, sortOrder: 0,
  config: { githubToken: 'ghp_test' }, flagOverrides: {}, disabledPublicModelIds: [],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
})

const stubRepo = (ups: UpstreamRecord[]): Repo => ({ upstreams: { list: async () => ups } } as unknown as Repo)

const originalFetch = globalThis.fetch
function installFetch(handler: (req: Request) => Promise<Response> | Response) {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    return Promise.resolve(handler(req))
  }) as typeof fetch
}

afterEach(() => { globalThis.fetch = originalFetch; setRepoForTest(null) })

function buildApp(auth: DataPlaneAuthCtx, store: InMemoryResponsesSnapshotStore) {
  const wrapper = new Hono()
  wrapper.use('*', (c, next) => {
    c.set('auth', auth)
    ;(c.env as unknown as { responsesStore: InMemoryResponsesSnapshotStore }).responsesStore = store
    return next()
  })
  wrapper.route('/', innerApp)
  return wrapper
}

const COPILOT_TOKEN = 'tkn'
const MODEL_ID = 'gpt-5-mini'

test('responses + previous_response_id expands snapshot and clears the field', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  const store = new InMemoryResponsesSnapshotStore()
  await store.save({
    responseId: 'resp_prev',
    apiKeyId: 'k1',
    model: MODEL_ID,
    items: [
      { type: 'message', role: 'user', content: 'turn1 user' },
      { type: 'message', role: 'assistant', content: 'turn1 assistant' },
    ],
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  })

  let observedUpstreamBody: { input?: unknown[]; previous_response_id?: unknown } | null = null
  installFetch((req) => {
    if (req.url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [stubModel(MODEL_ID)] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    if (req.url.endsWith('/responses')) {
      return req.json().then((body) => {
        observedUpstreamBody = body as typeof observedUpstreamBody
        return new Response(JSON.stringify({
          id: 'resp_new', object: 'response', model: MODEL_ID,
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'turn2 ok' }] }],
          usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      })
    }
    return new Response('not found', { status: 404 })
  })

  const wrapper = buildApp(
    { apiKeyId: 'k1', userId: 'u1', copilot: { copilotToken: COPILOT_TOKEN, accountType: 'individual' } } as DataPlaneAuthCtx,
    store,
  )
  const res = await wrapper.fetch(new Request('http://x/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      previous_response_id: 'resp_prev',
      input: [{ type: 'message', role: 'user', content: 'turn2 user' }],
    }),
  }), {} as never)

  expect(res.status).toBe(200)
  expect(observedUpstreamBody).not.toBeNull()
  expect(observedUpstreamBody!.previous_response_id).toBeUndefined()
  expect(observedUpstreamBody!.input).toEqual([
    { type: 'message', role: 'user', content: 'turn1 user' },
    { type: 'message', role: 'assistant', content: 'turn1 assistant' },
    { type: 'message', role: 'user', content: 'turn2 user' },
  ])
})
```

- [ ] **Step 2: Run, confirm fail**

Run: `bun test vnext/apps/gateway/tests/responses-previous-id.e2e.test.ts`
Expected: FAIL — request reaches upstream with `previous_response_id` still present, because the route does not yet expand.

- [ ] **Step 3: Modify the `/v1/responses` route to call `expandPreviousResponseId`**

In `vnext/apps/gateway/src/data-plane/routes.ts`, locate the `dataPlane.post('/v1/responses', …)` handler. After parsing `raw` and before the `dispatch(...)` call, intercept and expand:

```ts
import {
  expandPreviousResponseId,
  PreviousResponseNotFoundError,
  savePostTurnSnapshot,
} from './dispatch/responses-store-bridge.ts'
import { renderPreviousResponseNotFound } from './errors/repackage.ts'
```

Inside the handler (placement: after the existing `image_generation` short-circuit, before `return dispatch(...)`):

```ts
const auth = (c.get('auth' as never) ?? {}) as DataPlaneAuthCtx
const store = c.env.responsesStore
if (store) {
  try {
    await expandPreviousResponseId(
      raw as { previous_response_id?: string | null; input?: unknown },
      store,
      auth.apiKeyId ?? null,
    )
  } catch (err) {
    if (err instanceof PreviousResponseNotFoundError) {
      return renderPreviousResponseNotFound(err)
    }
    throw err
  }
}
```

(Replace any duplicate `auth` declaration; reuse the single `auth` value already bound in the existing handler.)

- [ ] **Step 4: Run, confirm pass**

Run: `bun test vnext/apps/gateway/tests/responses-previous-id.e2e.test.ts`
Expected: PASS — upstream body sees only `input` (3 items), no `previous_response_id`.

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/routes.ts \
        vnext/apps/gateway/tests/responses-previous-id.e2e.test.ts
git commit -m "feat(gateway/responses): expand previous_response_id before dispatch"
```

---

## Task 7: Render the verbatim 400 envelope when the snapshot is missing

**Files:**
- Modify: `vnext/apps/gateway/tests/responses-previous-id.e2e.test.ts` (add cases)

(The route already does the right thing thanks to Task 6; this task locks in the missing-id and ownership cases via tests.)

- [ ] **Step 1: Add failing test cases**

```ts
test('responses + unknown previous_response_id returns 400 with verbatim envelope', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  const store = new InMemoryResponsesSnapshotStore()
  installFetch((req) => {
    if (req.url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [stubModel(MODEL_ID)] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('upstream must not be called', { status: 500 })
  })

  const wrapper = buildApp(
    { apiKeyId: 'k1', userId: 'u1', copilot: { copilotToken: COPILOT_TOKEN, accountType: 'individual' } } as DataPlaneAuthCtx,
    store,
  )
  const res = await wrapper.fetch(new Request('http://x/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      previous_response_id: 'resp_missing',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
    }),
  }), {} as never)

  expect(res.status).toBe(400)
  const body = await res.json() as { error: { code: string; param: string; type: string; message: string } }
  expect(body.error.code).toBe('previous_response_not_found')
  expect(body.error.param).toBe('previous_response_id')
  expect(body.error.type).toBe('invalid_request_error')
  expect(body.error.message).toBe("Previous response with id 'resp_missing' not found.")
})

test('responses + previous_response_id owned by another api key returns 400', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  const store = new InMemoryResponsesSnapshotStore()
  await store.save({
    responseId: 'resp_owned',
    apiKeyId: 'k_other',
    model: MODEL_ID,
    items: [{ type: 'message', role: 'user', content: 'secret' }],
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  })
  installFetch((req) => {
    if (req.url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [stubModel(MODEL_ID)] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('upstream must not be called', { status: 500 })
  })

  const wrapper = buildApp(
    { apiKeyId: 'k1', userId: 'u1', copilot: { copilotToken: COPILOT_TOKEN, accountType: 'individual' } } as DataPlaneAuthCtx,
    store,
  )
  const res = await wrapper.fetch(new Request('http://x/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      previous_response_id: 'resp_owned',
      input: [{ type: 'message', role: 'user', content: 'turn2' }],
    }),
  }), {} as never)
  expect(res.status).toBe(400)
  const body = await res.json() as { error: { code: string } }
  expect(body.error.code).toBe('previous_response_not_found')
})
```

- [ ] **Step 2: Run, confirm both pass**

Run: `bun test vnext/apps/gateway/tests/responses-previous-id.e2e.test.ts`
Expected: PASS — three tests in this file now.

- [ ] **Step 3: Commit**

```bash
git add vnext/apps/gateway/tests/responses-previous-id.e2e.test.ts
git commit -m "test(gateway/responses): cover unknown id + cross-apiKey snapshot ownership"
```

---

## Task 8: Persist post-turn snapshot for non-streaming responses

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/routes.ts`
- Test: `vnext/apps/gateway/tests/responses-previous-id.e2e.test.ts`

The `dispatch()` helper currently returns a `Response` directly. We need to intercept the response so we can extract `id`, `output`, and the original `input` for `savePostTurnSnapshot`. Strategy: do the save in the route handler itself, after `dispatch()` returns, by cloning the body when `content-type: application/json`. Stream path is handled in Task 9.

- [ ] **Step 1: Write failing test for the save**

```ts
test('responses non-stream saves snapshot using upstream response.id', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  const store = new InMemoryResponsesSnapshotStore()
  installFetch((req) => {
    if (req.url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [stubModel(MODEL_ID)] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    if (req.url.endsWith('/responses')) {
      return new Response(JSON.stringify({
        id: 'resp_saved_xyz', object: 'response', model: MODEL_ID,
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('not found', { status: 404 })
  })

  const wrapper = buildApp(
    { apiKeyId: 'k1', userId: 'u1', copilot: { copilotToken: COPILOT_TOKEN, accountType: 'individual' } } as DataPlaneAuthCtx,
    store,
  )
  const res = await wrapper.fetch(new Request('http://x/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    }),
  }), {} as never)
  expect(res.status).toBe(200)
  // give the post-turn save a tick to settle (it's awaited in-route, but we
  // read the body to be sure the response has been emitted)
  await res.text()
  const snap = await store.load('resp_saved_xyz', 'k1')
  expect(snap).not.toBeNull()
  expect(snap!.model).toBe(MODEL_ID)
  // items must include both the user input and the assistant output
  expect(JSON.stringify(snap!.items)).toContain('hello')
  expect(JSON.stringify(snap!.items)).toContain('ok')
})
```

- [ ] **Step 2: Run, confirm fail**

Run: `bun test vnext/apps/gateway/tests/responses-previous-id.e2e.test.ts`
Expected: FAIL — `store.load('resp_saved_xyz', 'k1')` returns null.

- [ ] **Step 3: Wrap the `/v1/responses` route to capture the response and save**

Modify the `/v1/responses` handler in `routes.ts` so that after the handler obtains the `Response` from `dispatch(...)`, it tees the body for inspection. Concretely, restructure as:

```ts
// (still inside the handler, after expand)
const response = await dispatch(
  { req: { json: async () => raw } },
  {
    parse: (r) => parseResponsesPayload(r),
    modelOf: (p) => (p as { model?: string }).model ?? '',
    sourceApi: 'responses',
    errorWrap: messagesErrorWrap,
    auth,
    obsCtx,
  },
)

if (!store || response.status !== 200) return response
const ct = response.headers.get('content-type') ?? ''
if (ct.includes('text/event-stream')) {
  // Stream path handled in Task 9 — return as-is for now.
  return response
}
if (!ct.includes('application/json')) return response

const cloned = response.clone()
try {
  const json = await cloned.json() as {
    id?: string
    model?: string
    output?: unknown[]
  }
  const inputItems = Array.isArray((raw as { input?: unknown }).input)
    ? ((raw as { input: unknown[] }).input)
    : []
  if (typeof json.id === 'string' && Array.isArray(json.output)) {
    await savePostTurnSnapshot(store, {
      responseId: json.id,
      apiKeyId: auth.apiKeyId ?? null,
      model: typeof json.model === 'string' ? json.model : ((raw as { model?: string }).model ?? ''),
      inputItems,
      outputItems: json.output,
    })
  }
} catch (err) {
  console.warn('savePostTurnSnapshot (non-stream) failed', err)
}
return response
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun test vnext/apps/gateway/tests/responses-previous-id.e2e.test.ts`
Expected: PASS — four tests now.

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/routes.ts \
        vnext/apps/gateway/tests/responses-previous-id.e2e.test.ts
git commit -m "feat(gateway/responses): persist non-stream post-turn snapshot"
```

---

## Task 9: Persist post-turn snapshot for streaming responses

**Files:**
- Modify: `vnext/apps/gateway/src/data-plane/routes.ts`
- Test: `vnext/apps/gateway/tests/responses-previous-id.e2e.test.ts`

Streaming responses cannot be JSON-parsed; the `id` and final `output` items live inside the SSE event stream (`response.created`, `response.output_item.done`, `response.completed`). Strategy: tee the response body so the client receives bytes in real time while a sidecar reader collects the stream into typed events, extracts `id` + final output items, and calls `savePostTurnSnapshot` after the stream closes.

- [ ] **Step 1: Write failing test for the streaming save**

```ts
test('responses stream saves snapshot when response.completed fires', async () => {
  setRepoForTest(stubRepo([stubUpstream()]))
  const store = new InMemoryResponsesSnapshotStore()

  const sse = (events: Array<{ type: string; data: unknown }>) => {
    const enc = new TextEncoder()
    return new ReadableStream<Uint8Array>({
      start(c) {
        for (const e of events) c.enqueue(enc.encode(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`))
        c.close()
      },
    })
  }

  installFetch((req) => {
    if (req.url.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [stubModel(MODEL_ID)] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    if (req.url.endsWith('/responses')) {
      return new Response(sse([
        { type: 'response.created', data: { type: 'response.created', response: { id: 'resp_stream_1', model: MODEL_ID } } },
        { type: 'response.output_item.done', data: {
          type: 'response.output_item.done', output_index: 0,
          item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'streamed' }] },
        } },
        { type: 'response.completed', data: { type: 'response.completed', response: { id: 'resp_stream_1', model: MODEL_ID, status: 'completed' } } },
      ]), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('not found', { status: 404 })
  })

  const wrapper = buildApp(
    { apiKeyId: 'k1', userId: 'u1', copilot: { copilotToken: COPILOT_TOKEN, accountType: 'individual' } } as DataPlaneAuthCtx,
    store,
  )
  const res = await wrapper.fetch(new Request('http://x/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID,
      stream: true,
      input: [{ type: 'message', role: 'user', content: 'streamed user' }],
    }),
  }), {} as never)
  expect(res.status).toBe(200)
  // Drain the stream so the sidecar save completes.
  const reader = res.body!.getReader()
  while (true) { const { done } = await reader.read(); if (done) break }
  // sidecar save runs after the stream closes; give it a microtask tick
  await new Promise((r) => setTimeout(r, 10))
  const snap = await store.load('resp_stream_1', 'k1')
  expect(snap).not.toBeNull()
  expect(JSON.stringify(snap!.items)).toContain('streamed user')
  expect(JSON.stringify(snap!.items)).toContain('streamed')
})
```

- [ ] **Step 2: Run, confirm fail**

Run: `bun test vnext/apps/gateway/tests/responses-previous-id.e2e.test.ts`
Expected: FAIL — `store.load('resp_stream_1', 'k1')` returns null.

- [ ] **Step 3: Add the SSE tee + sidecar collector to the route**

Inside the same `/v1/responses` handler block, replace the early-return for `text/event-stream` with a tee:

```ts
import { parseResponsesSSEStream } from '@vnext/provider-copilot'

// … inside the handler, after the json branch is moved into an `else`:
if (ct.includes('text/event-stream') && response.body) {
  const [forClient, forSidecar] = response.body.tee()
  const inputItems = Array.isArray((raw as { input?: unknown }).input)
    ? ((raw as { input: unknown[] }).input)
    : []
  const fallbackModel = (raw as { model?: string }).model ?? ''
  ;(async () => {
    let responseId: string | null = null
    let model = fallbackModel
    const outputItems: unknown[] = []
    try {
      for await (const evt of parseResponsesSSEStream(forSidecar)) {
        const e = evt as { type?: string; response?: { id?: string; model?: string }; item?: unknown }
        if (e.type === 'response.created' && e.response?.id) {
          responseId = e.response.id
          if (e.response.model) model = e.response.model
        } else if (e.type === 'response.output_item.done' && e.item) {
          outputItems.push(e.item)
        } else if (e.type === 'response.completed') {
          if (e.response?.id && !responseId) responseId = e.response.id
          if (e.response?.model) model = e.response.model
        }
      }
      if (responseId) {
        await savePostTurnSnapshot(store, {
          responseId,
          apiKeyId: auth.apiKeyId ?? null,
          model,
          inputItems,
          outputItems,
        })
      }
    } catch (err) {
      console.warn('savePostTurnSnapshot (stream) failed', err)
    }
  })()
  return new Response(forClient, { status: response.status, headers: response.headers })
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `bun test vnext/apps/gateway/tests/responses-previous-id.e2e.test.ts`
Expected: PASS — five tests.

- [ ] **Step 5: Commit**

```bash
git add vnext/apps/gateway/src/data-plane/routes.ts \
        vnext/apps/gateway/tests/responses-previous-id.e2e.test.ts
git commit -m "feat(gateway/responses): persist streaming post-turn snapshot via tee"
```

---

## Task 10: openai-node SDK multi-turn integration test

**Files:**
- Create: `tests/sdk-openai-responses-multi-turn.test.ts`

This test runs against a live local gateway (`bun run local`) just like the other `tests/sdk-*` integration tests. It exercises the full path: turn 1 stores a snapshot keyed by the upstream `response.id`; turn 2 references it by `previous_response_id` and we assert the assistant remembers turn-1 content.

- [ ] **Step 1: Write the test**

```ts
// tests/sdk-openai-responses-multi-turn.test.ts
/**
 * Adapted from openai-node's responses examples — the official SDK shape is
 * `client.responses.create({ model, input, previous_response_id })`. We run
 * the same shape against the gateway to prove `previous_response_id`
 * expansion works end-to-end via the snapshot store.
 *
 * Pre-req: `bun run local` is up at TEST_API_BASE_URL.
 */
import { test, expect } from 'bun:test'
import OpenAI from 'openai'

const baseURL = process.env.TEST_API_BASE_URL ?? 'http://localhost:8787/v1'

const client = new OpenAI({ apiKey: 'test-key', baseURL })

test('responses previous_response_id round-trip on a chat-backed model', async () => {
  const turn1 = await client.responses.create({
    model: 'gpt-4o-mini',
    input: [{ role: 'user', content: 'My favorite color is azure. Remember it.' }],
  })
  expect(turn1.id).toMatch(/^resp/)

  const turn2 = await client.responses.create({
    model: 'gpt-4o-mini',
    previous_response_id: turn1.id,
    input: [{ role: 'user', content: 'What is my favorite color?' }],
  })
  const text = JSON.stringify(turn2.output ?? [])
  expect(text.toLowerCase()).toContain('azure')
}, 60_000)

test('responses previous_response_id round-trip on a responses-backed model', async () => {
  // Run if the deployment exposes a responses-native model id; skip otherwise.
  const modelId = process.env.TEST_RESPONSES_MODEL_ID
  if (!modelId) return
  const turn1 = await client.responses.create({
    model: modelId,
    input: [{ role: 'user', content: 'My lucky number is 73. Remember it.' }],
  })
  expect(turn1.id).toMatch(/^resp/)

  const turn2 = await client.responses.create({
    model: modelId,
    previous_response_id: turn1.id,
    input: [{ role: 'user', content: 'What is my lucky number?' }],
  })
  const text = JSON.stringify(turn2.output ?? [])
  expect(text).toContain('73')
}, 60_000)

test('unknown previous_response_id surfaces 400 previous_response_not_found', async () => {
  await expect(
    client.responses.create({
      model: 'gpt-4o-mini',
      previous_response_id: 'resp_definitely_not_real',
      input: [{ role: 'user', content: 'hi' }],
    }),
  ).rejects.toMatchObject({ status: 400 })
}, 30_000)
```

- [ ] **Step 2: Smoke-run against a local gateway**

```bash
bun run local &
sleep 3
bun test tests/sdk-openai-responses-multi-turn.test.ts
```

Expected: All three tests pass (the responses-backed test silently no-ops when `TEST_RESPONSES_MODEL_ID` is unset).

- [ ] **Step 3: Commit**

```bash
git add tests/sdk-openai-responses-multi-turn.test.ts
git commit -m "test(sdk): openai-node responses multi-turn previous_response_id"
```

---

## Self-Review

**Spec coverage** (mapped to `2026-06-12-p1-chat-responses-mesh-and-previous-id-design.md`):

| Spec section | Plan 3 task |
|---|---|
| §1 Responses-store independent package | Plan 1 (already shipped) — consumed here via Tasks 1-3, 5 |
| §3 chat ↔ responses translator pair | Plan 2 (already shipped) — composes with previous-id wiring uniformly |
| §4 dispatch bridge — `expandPreviousResponseId` | Tasks 1-2 |
| §4 dispatch bridge — `savePostTurnSnapshot` | Tasks 3, 8, 9 |
| §4 dispatch bridge — `PreviousResponseNotFoundError` shape | Task 1 |
| §5 routes.ts /v1/responses changes | Tasks 6, 8, 9 |
| §5 Env injection (D1 vs bun:sqlite) | Task 5 |
| §6 verbatim 400 envelope | Task 4, locked in by Task 7 |
| Test strategy — InMemory + dispatch e2e | Tasks 2, 3, 6-9 |
| Test strategy — openai-node SDK multi-turn | Task 10 |

No spec section is unaddressed. The cross-apiKey isolation rule (§1 "Ownership Isolation") is exercised at both unit (Task 2) and e2e (Task 7) layers.

**Placeholder scan:** No "TBD", "implement later", or vague-error patches. Each step contains the exact code the implementer should paste; each test contains real assertions. Where a behavior is delegated to upstream code (e.g., `parseResponsesSSEStream` typing), the call site is concrete and the contract is established by the existing `provider-copilot` package.

**Type consistency check:**
- `expandPreviousResponseId` uses `payload: { previous_response_id?: string | null; input?: unknown }` consistently across Tasks 1, 2, and 6.
- `savePostTurnSnapshot` signature is identical in Tasks 1, 3, 8, and 9.
- `Env.responsesStore` is `ResponsesSnapshotStore | undefined` in `app.ts` and the route guards on truthiness everywhere it is used.
- `PreviousResponseNotFoundError.responseId` is read by the renderer in Task 4 and by tests in Tasks 1, 7.

**Faithfulness:** No synthesized fields. The verbatim envelope mirrors the OpenAI capture exactly. Snapshot expansion preserves item order and shape; nothing is normalized or rewritten. Save errors are warned and swallowed only — they never alter the user-visible response.

**Scope discipline:** No edits inside `packages/translate/`, `packages/responses-store/`, the pair selector, or the translator registry. Changes are concentrated in five files (one new bridge module, one new factory, two route/Env touch-ups, one error renderer addition) plus tests.

---

## Execution Handoff

Plan complete and ready to commit. After commit, two execution options:

**1. Subagent-Driven (recommended)** — REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Tasks 1-10 are tightly ordered (each builds on the previous module's exports), so dispatch sequentially with two-stage review per task.

**2. Inline Execution** — REQUIRED SUB-SKILL: superpowers:executing-plans. Batch checkpoints after Tasks 4, 7, and 10.
