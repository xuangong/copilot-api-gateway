# Plan 1: Extract `@vnext/shared-http` + Collect Copilot Inline Helpers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the `@vnext/shared-http` package containing `fetchWithRetry`, `mergeHeaders`, `parseJsonBody`, `truncateBody`; collect the equivalent inline implementations from `@vnext/provider-copilot` to lock the transport boundary before plan2/plan3 import it.

**Architecture:** Pure-relocation refactor. The four helpers move into a new workspace package; copilot's `lib/fetch-retry.ts` is deleted and its inline `parseJsonBody`/`mergeHeaders` (in `provider.ts`) and inline error-body truncate (in `forward.ts:79-89`) are replaced by re-exports/imports from `@vnext/shared-http`. **Zero behavior change** for the copilot data plane — the same retry curve, same timeout semantics, same header merge order, same 200-char truncate.

**Tech Stack:** Bun 1.3 workspace, TypeScript (strict, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`), `bun test` with `globalThis.fetch` mocking.

**Spec reference:** `vnext/docs/superpowers/specs/2026-06-13-vnext-custom-azure-providers-design.md` §1.3, §3.1, §3.2, §6 (non-goals: do not change `fetchWithRetry` behavior), §7 (acceptance: plan1 = zero copilot diff), §8 (plan1 is the prerequisite).

---

## File Structure

**New package — `vnext/packages/shared-http/`:**
- `package.json` — workspace name `@vnext/shared-http`, no runtime deps (helpers are self-contained; HTTPError stays in `@vnext/provider`).
- `tsconfig.json` — extends `../../tsconfig.base.json`, `include: ["src/**/*.ts"]`.
- `src/index.ts` — barrel; re-exports `./fetch-retry`, `./headers`, `./body`.
- `src/fetch-retry.ts` — `FetchOptions` interface + `fetchWithRetry()` function. **Verbatim move** of `vnext/packages/provider-copilot/src/lib/fetch-retry.ts`.
- `src/headers.ts` — `mergeHeaders()` function. **Verbatim move** of the local function from `vnext/packages/provider-copilot/src/provider.ts:303-314`.
- `src/body.ts` — `parseJsonBody()` (moved from `vnext/packages/provider-copilot/src/provider.ts:296-301`) + new `truncateBody(s, max=200)` helper (extracted from `vnext/packages/provider-copilot/src/forward.ts:85-88`).
- `src/__tests__/fetch-retry.test.ts` — 6 test cases for retry/timeout behavior.
- `src/__tests__/headers.test.ts` — 4 test cases for merge semantics.
- `src/__tests__/body.test.ts` — 6 test cases (parseJsonBody + truncateBody).

**Modified — `vnext/packages/provider-copilot/`:**
- `package.json` — add `"@vnext/shared-http": "workspace:*"` dep.
- `src/lib/fetch-retry.ts` — **deleted**.
- `src/forward.ts` — import `fetchWithRetry, truncateBody` from `@vnext/shared-http`; replace inline truncate at lines 85-88.
- `src/provider.ts` — import `parseJsonBody, mergeHeaders` from `@vnext/shared-http`; delete the two local function definitions at lines 296-314.

**Untouched:**
- `@vnext/provider` — `HTTPError` stays where it is (it's a contract type, not transport).
- All other copilot files (`headers.ts`, `account-type.ts`, `flags.ts`, interceptors, parsers, models).
- `vnext/apps/gateway/*` — gateway is **not** touched in plan1.

---

## Task 1: Create `@vnext/shared-http` package scaffold

**Files:**
- Create: `vnext/packages/shared-http/package.json`
- Create: `vnext/packages/shared-http/tsconfig.json`
- Create: `vnext/packages/shared-http/src/index.ts` (empty barrel for now)

- [ ] **Step 1: Create `package.json`**

Write `vnext/packages/shared-http/package.json`:

```json
{
  "name": "@vnext/shared-http",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./fetch-retry": "./src/fetch-retry.ts",
    "./headers": "./src/headers.ts",
    "./body": "./src/body.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

Write `vnext/packages/shared-http/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create empty barrel `src/index.ts`**

Write `vnext/packages/shared-http/src/index.ts`:

```ts
// barrel — populated by tasks 2-4
export {}
```

- [ ] **Step 4: Wire workspace + verify install**

Workspaces already glob `packages/*` (`vnext/package.json` line 5-8), so `bun install` from `vnext/` picks the new package up automatically.

Run from `/Users/zhangxian/projects/copilot-api-gateway/vnext`:
```bash
bun install
```
Expected: completes without errors; new entry appears in lockfile.

Run typecheck for the new package:
```bash
cd vnext/packages/shared-http && bun run typecheck
```
Expected: passes (empty barrel compiles).

- [ ] **Step 5: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/shared-http/ vnext/bun.lock 2>/dev/null
# bun.lock may or may not be present depending on how the workspace tracks it
git add -A vnext/packages/shared-http
git commit -m "feat(vnext/shared-http): scaffold empty package

Workspace-only package, no runtime deps. Subsequent tasks populate
fetch-retry, headers, and body modules with helpers lifted verbatim
from @vnext/provider-copilot."
```

---

## Task 2: Move `fetchWithRetry` into `shared-http` (TDD)

**Files:**
- Create: `vnext/packages/shared-http/src/fetch-retry.ts`
- Create: `vnext/packages/shared-http/src/__tests__/fetch-retry.test.ts`
- Modify: `vnext/packages/shared-http/src/index.ts`

- [ ] **Step 1: Write failing test for fetchWithRetry behavior**

Write `vnext/packages/shared-http/src/__tests__/fetch-retry.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { fetchWithRetry } from '../fetch-retry.ts'

const realFetch = globalThis.fetch

describe('fetchWithRetry', () => {
  let calls: Array<{ url: string; init?: RequestInit }>
  let responses: Array<() => Response | Promise<Response> | never>

  beforeEach(() => {
    calls = []
    responses = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      const i = calls.length - 1
      const factory = responses[i]
      if (!factory) throw new Error(`unexpected fetch #${i + 1}`)
      return factory()
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('returns 200 on first success without retrying', async () => {
    responses.push(() => new Response('ok', { status: 200 }))
    const res = await fetchWithRetry('https://example.com')
    expect(res.status).toBe(200)
    expect(calls.length).toBe(1)
  })

  test('retries on 5xx and returns final success', async () => {
    responses.push(() => new Response('boom', { status: 503 }))
    responses.push(() => new Response('ok', { status: 200 }))
    const res = await fetchWithRetry('https://example.com', { retryDelay: 1 })
    expect(res.status).toBe(200)
    expect(calls.length).toBe(2)
  })

  test('retries on 429 and returns final success', async () => {
    responses.push(() => new Response('rate', { status: 429 }))
    responses.push(() => new Response('ok', { status: 200 }))
    const res = await fetchWithRetry('https://example.com', { retryDelay: 1 })
    expect(res.status).toBe(200)
    expect(calls.length).toBe(2)
  })

  test('does NOT retry on 4xx (other than 429) and returns the 4xx response', async () => {
    responses.push(() => new Response('bad', { status: 400 }))
    const res = await fetchWithRetry('https://example.com', { retryDelay: 1, maxRetries: 3 })
    expect(res.status).toBe(400)
    expect(calls.length).toBe(1)
  })

  test('returns the final 5xx response after exhausting maxRetries', async () => {
    responses.push(() => new Response('a', { status: 500 }))
    responses.push(() => new Response('b', { status: 502 }))
    responses.push(() => new Response('c', { status: 503 }))
    responses.push(() => new Response('d', { status: 504 }))
    const res = await fetchWithRetry('https://example.com', { retryDelay: 1, maxRetries: 3 })
    expect(res.status).toBe(504)
    expect(calls.length).toBe(4) // initial + 3 retries
  })

  test('timeout triggers AbortController and throws with timeout message', async () => {
    responses.push(() => new Promise<Response>((_resolve, reject) => {
      // Never resolves — let the abort signal fire.
      const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      // Pick up the signal from the most recent init the fetch shim saw.
      const init = calls[calls.length - 1]?.init
      init?.signal?.addEventListener('abort', onAbort, { once: true })
    }))
    await expect(
      fetchWithRetry('https://example.com', { timeout: 5, maxRetries: 0 }),
    ).rejects.toThrow(/timeout after 5ms/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/shared-http
bun test src/__tests__/fetch-retry.test.ts
```
Expected: FAIL with module resolution error for `'../fetch-retry.ts'` (file doesn't exist yet).

- [ ] **Step 3: Create `fetch-retry.ts` (verbatim copy)**

Write `vnext/packages/shared-http/src/fetch-retry.ts` — **verbatim** content lifted from `vnext/packages/provider-copilot/src/lib/fetch-retry.ts` (same retry curve, same timeout/AbortController logic, same console.log messages):

```ts
/**
 * fetchWithRetry — exponential backoff retry on 429/5xx, AbortController-based
 * timeout. Lifted verbatim from @vnext/provider-copilot/src/lib/fetch-retry.ts
 * (which itself was lifted from apps/gateway/src/shared/lib/fetch-retry.ts).
 *
 * Behavior, retry curve, timeout semantics: unchanged.
 */
export interface FetchOptions extends RequestInit {
  maxRetries?: number
  retryDelay?: number
  timeout?: number // Request timeout in milliseconds
}

export async function fetchWithRetry(
  input: string | URL,
  init?: FetchOptions,
): Promise<Response> {
  const maxRetries = init?.maxRetries ?? 3
  const retryDelay = init?.retryDelay ?? 1000
  const timeout = init?.timeout

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      let controller: AbortController | undefined
      let timeoutId: ReturnType<typeof setTimeout> | undefined

      if (timeout) {
        controller = new AbortController()
        timeoutId = setTimeout(() => controller!.abort(), timeout)
      }

      const response = await fetch(input, {
        ...init,
        signal: controller?.signal ?? init?.signal,
      }).finally(() => {
        if (timeoutId) clearTimeout(timeoutId)
      })

      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return response
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt === maxRetries) {
          console.log(`[fetch] Failed after ${attempt + 1} attempts: HTTP ${response.status}`)
          return response
        }
        const delay = Math.min(retryDelay * Math.pow(2, attempt), 10000)
        console.log(`[fetch] Attempt ${attempt + 1} got HTTP ${response.status}, retrying in ${delay}ms...`)
        await new Promise((r) => setTimeout(r, delay))
        continue
      }

      return response
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === "AbortError"
      const errMsg = isTimeout ? `timeout after ${timeout}ms` : (error instanceof Error ? error.message : String(error))

      if (attempt === maxRetries) {
        console.log(`[fetch] Failed after ${attempt + 1} attempts: ${errMsg}`)
        if (isTimeout) {
          throw new Error(`Request timeout after ${timeout}ms (${maxRetries + 1} attempts)`)
        }
        throw error
      }

      const delay = Math.min(retryDelay * Math.pow(2, attempt), 10000)
      console.log(`[fetch] Attempt ${attempt + 1} failed (${errMsg}), retrying in ${delay}ms...`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }

  throw new Error("Max retries exceeded")
}
```

- [ ] **Step 4: Update barrel to export `fetch-retry`**

Edit `vnext/packages/shared-http/src/index.ts` — replace the placeholder:

```ts
export * from './fetch-retry'
```

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/shared-http
bun test src/__tests__/fetch-retry.test.ts
```
Expected: all 6 tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/shared-http/src/fetch-retry.ts \
        vnext/packages/shared-http/src/__tests__/fetch-retry.test.ts \
        vnext/packages/shared-http/src/index.ts
git commit -m "feat(vnext/shared-http): add fetchWithRetry (verbatim from copilot lib)

Same retry curve (429/5xx, exponential backoff capped at 10s, default
maxRetries=3, retryDelay=1000ms), same AbortController-based timeout.
Tests use globalThis.fetch shim to avoid Bun mock.module() leakage."
```

---

## Task 3: Move `mergeHeaders` into `shared-http` (TDD)

**Files:**
- Create: `vnext/packages/shared-http/src/headers.ts`
- Create: `vnext/packages/shared-http/src/__tests__/headers.test.ts`
- Modify: `vnext/packages/shared-http/src/index.ts`

- [ ] **Step 1: Write failing tests for mergeHeaders**

Write `vnext/packages/shared-http/src/__tests__/headers.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { mergeHeaders } from '../headers.ts'

describe('mergeHeaders', () => {
  test('returns empty object when both inputs are undefined', () => {
    expect(mergeHeaders(undefined, undefined)).toEqual({})
  })

  test('returns lowercased init headers when extra is undefined (Headers normalizes case)', () => {
    const out = mergeHeaders({ Authorization: 'Bearer x', 'X-Foo': '1' }, undefined)
    // The Headers class normalizes header names to lowercase; that is the
    // behavior we lift from copilot. Lock it explicitly here.
    expect(out['authorization']).toBe('Bearer x')
    expect(out['x-foo']).toBe('1')
  })

  test('extra fully overrides init when keys collide', () => {
    const out = mergeHeaders(
      { authorization: 'Bearer init', 'x-keep': 'init' },
      { authorization: 'Bearer extra', 'x-new': 'extra' },
    )
    expect(out['authorization']).toBe('Bearer extra')
    expect(out['x-keep']).toBe('init')
    expect(out['x-new']).toBe('extra')
  })

  test('accepts HeadersInit array form for init', () => {
    const out = mergeHeaders(
      [['authorization', 'Bearer x'], ['x-foo', '1']],
      { 'x-foo': '2' },
    )
    expect(out['authorization']).toBe('Bearer x')
    expect(out['x-foo']).toBe('2')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/shared-http
bun test src/__tests__/headers.test.ts
```
Expected: FAIL with module resolution error.

- [ ] **Step 3: Create `headers.ts` (verbatim from copilot)**

Write `vnext/packages/shared-http/src/headers.ts`:

```ts
/**
 * mergeHeaders — flattens an init headers value (HeadersInit) into a plain
 * Record and lets `extra` override on key collision. Lifted verbatim from
 * @vnext/provider-copilot/src/provider.ts mergeHeaders helper.
 *
 * Header names are lowercased by the Headers normalization that happens
 * inside `new Headers(initHeaders)`. Callers (CopilotProvider etc.) rely on
 * that behavior; do not change it.
 */
export function mergeHeaders(
  initHeaders: RequestInit['headers'] | undefined,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (initHeaders) {
    const h = new Headers(initHeaders)
    h.forEach((v, k) => { out[k] = v })
  }
  if (extra) Object.assign(out, extra)
  return out
}
```

- [ ] **Step 4: Add `headers` to barrel**

Edit `vnext/packages/shared-http/src/index.ts`:

```ts
export * from './fetch-retry'
export * from './headers'
```

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/shared-http
bun test src/__tests__/headers.test.ts
```
Expected: all 4 tests pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/shared-http/src/headers.ts \
        vnext/packages/shared-http/src/__tests__/headers.test.ts \
        vnext/packages/shared-http/src/index.ts
git commit -m "feat(vnext/shared-http): add mergeHeaders (verbatim from copilot)

Flattens HeadersInit → Record with extra overriding init. Header names
are normalized to lowercase via the Headers class, matching copilot's
existing behavior."
```

---

## Task 4: Move `parseJsonBody` + add `truncateBody` (TDD)

**Files:**
- Create: `vnext/packages/shared-http/src/body.ts`
- Create: `vnext/packages/shared-http/src/__tests__/body.test.ts`
- Modify: `vnext/packages/shared-http/src/index.ts`

- [ ] **Step 1: Write failing tests for body helpers**

Write `vnext/packages/shared-http/src/__tests__/body.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { parseJsonBody, truncateBody } from '../body.ts'

describe('parseJsonBody', () => {
  test('parses a valid JSON string into an object', () => {
    expect(parseJsonBody('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' })
  })

  test('throws when body is undefined', () => {
    expect(() => parseJsonBody(undefined)).toThrow(/body must be a JSON string/)
  })

  test('throws when body is null', () => {
    expect(() => parseJsonBody(null)).toThrow(/body must be a JSON string/)
  })

  test('throws when body is FormData (non-string BodyInit)', () => {
    const fd = new FormData()
    fd.append('k', 'v')
    expect(() => parseJsonBody(fd)).toThrow(/body must be a JSON string/)
  })
})

describe('truncateBody', () => {
  test('returns the original string when length <= max', () => {
    expect(truncateBody('hello', 200)).toBe('hello')
  })

  test('truncates and appends "...(truncated)" when length > max', () => {
    const s = 'x'.repeat(250)
    const out = truncateBody(s, 200)
    expect(out).toBe('x'.repeat(200) + '...(truncated)')
  })

  test('defaults max to 200 when omitted', () => {
    const s = 'y'.repeat(250)
    const out = truncateBody(s)
    expect(out).toBe('y'.repeat(200) + '...(truncated)')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/shared-http
bun test src/__tests__/body.test.ts
```
Expected: FAIL with module resolution error.

- [ ] **Step 3: Create `body.ts`**

Write `vnext/packages/shared-http/src/body.ts`:

```ts
/**
 * Body helpers shared across provider transports.
 *
 * parseJsonBody — lifted verbatim from @vnext/provider-copilot/src/provider.ts.
 *   The copilot transport always sends a JSON-string body; non-string bodies
 *   (FormData, ReadableStream, etc.) are a programmer error here. Custom/Azure
 *   providers (plan2/plan3) have FormData branches and call parseJsonBody only
 *   on the JSON paths, matching that contract.
 *
 * truncateBody — extracted from @vnext/provider-copilot/src/forward.ts:85-88.
 *   When an upstream error body isn't valid JSON, we cap it at `max` characters
 *   and append "...(truncated)" so logs/HTTPError messages stay readable.
 *   Default max=200 matches the existing inline behavior.
 */
export function parseJsonBody(
  body: BodyInit | null | undefined,
): Record<string, unknown> {
  if (typeof body !== 'string') {
    throw new Error('parseJsonBody: body must be a JSON string')
  }
  return JSON.parse(body) as Record<string, unknown>
}

export function truncateBody(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) + '...(truncated)' : s
}
```

- [ ] **Step 4: Add `body` to barrel**

Edit `vnext/packages/shared-http/src/index.ts`:

```ts
export * from './fetch-retry'
export * from './headers'
export * from './body'
```

- [ ] **Step 5: Run test to verify it passes**

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/shared-http
bun test
```
Expected: all 16 tests pass (6 fetch-retry + 4 headers + 6 body).

- [ ] **Step 6: Run typecheck**

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/shared-http
bun run typecheck
```
Expected: passes with no errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/shared-http/src/body.ts \
        vnext/packages/shared-http/src/__tests__/body.test.ts \
        vnext/packages/shared-http/src/index.ts
git commit -m "feat(vnext/shared-http): add parseJsonBody + truncateBody

parseJsonBody lifted from copilot provider.ts; truncateBody factored out
of forward.ts:85-88 (200-char cap + '...(truncated)' suffix). Both will
be reused by provider-custom and provider-azure in plan2/plan3."
```

---

## Task 5: Collect copilot's inline `fetchWithRetry` (delete `lib/fetch-retry.ts`)

**Files:**
- Modify: `vnext/packages/provider-copilot/package.json`
- Modify: `vnext/packages/provider-copilot/src/forward.ts:4`
- Delete: `vnext/packages/provider-copilot/src/lib/fetch-retry.ts`

- [ ] **Step 1: Add shared-http dependency to copilot's package.json**

Edit `vnext/packages/provider-copilot/package.json` — replace the existing `dependencies` object:

```json
  "dependencies": {
    "@vnext/protocols": "workspace:*",
    "@vnext/interceptor": "workspace:*",
    "@vnext/provider": "workspace:*",
    "@vnext/shared-http": "workspace:*"
  }
```

- [ ] **Step 2: Re-run bun install to link the new workspace dep**

Run from `/Users/zhangxian/projects/copilot-api-gateway/vnext`:
```bash
bun install
```
Expected: completes without errors; symlink `node_modules/@vnext/shared-http` points into `packages/shared-http`.

- [ ] **Step 3: Update `forward.ts` import**

Edit `vnext/packages/provider-copilot/src/forward.ts` — change line 4 from:

```ts
import { fetchWithRetry } from "./lib/fetch-retry"
```

to:

```ts
import { fetchWithRetry } from "@vnext/shared-http"
```

- [ ] **Step 4: Delete the old fetch-retry module**

Run:
```bash
rm /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/provider-copilot/src/lib/fetch-retry.ts
```

- [ ] **Step 5: Typecheck + run all copilot tests to confirm zero behavior diff**

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/provider-copilot
bun run typecheck
bun test
```
Expected: typecheck passes; all existing tests in `src/__tests__/endpoints.test.ts` and `__tests__/per-endpoint-methods.test.ts` pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-copilot/package.json \
        vnext/packages/provider-copilot/src/forward.ts
git add -u vnext/packages/provider-copilot/src/lib/fetch-retry.ts
git commit -m "refactor(vnext/provider-copilot): import fetchWithRetry from @vnext/shared-http

Deletes the local lib/fetch-retry.ts (was verbatim copy). Behavior
unchanged — same retry curve, same timeout, same console.log lines."
```

---

## Task 6: Replace copilot's inline `truncate` in `forward.ts`

**Files:**
- Modify: `vnext/packages/provider-copilot/src/forward.ts:78-103`

- [ ] **Step 1: Update import to include truncateBody**

Edit `vnext/packages/provider-copilot/src/forward.ts` line 4 — replace:

```ts
import { fetchWithRetry } from "@vnext/shared-http"
```

with:

```ts
import { fetchWithRetry, truncateBody } from "@vnext/shared-http"
```

- [ ] **Step 2: Replace the inline truncate block**

In `vnext/packages/provider-copilot/src/forward.ts`, find the block at lines 78-89:

```ts
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "")
    let errorDetail: string
    try {
      const parsed = JSON.parse(errorBody)
      errorDetail = JSON.stringify(parsed)
    } catch {
      errorDetail =
        errorBody.length > 200
          ? errorBody.slice(0, 200) + "...(truncated)"
          : errorBody
    }
```

Replace it with:

```ts
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "")
    let errorDetail: string
    try {
      const parsed = JSON.parse(errorBody)
      errorDetail = JSON.stringify(parsed)
    } catch {
      errorDetail = truncateBody(errorBody)
    }
```

- [ ] **Step 3: Typecheck + run all copilot tests to confirm zero diff**

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/provider-copilot
bun run typecheck
bun test
```
Expected: typecheck passes; all copilot tests pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-copilot/src/forward.ts
git commit -m "refactor(vnext/provider-copilot): use shared truncateBody for error body

Replaces the inline 200-char truncate at forward.ts:85-88. Output is
byte-identical: same cap, same '...(truncated)' suffix."
```

---

## Task 7: Replace copilot's inline `parseJsonBody` + `mergeHeaders` in `provider.ts`

**Files:**
- Modify: `vnext/packages/provider-copilot/src/provider.ts`

- [ ] **Step 1: Add import for the two helpers**

Edit `vnext/packages/provider-copilot/src/provider.ts`. The existing imports run through line 41. Insert a new import line after the existing `@vnext/provider` import block (anywhere in the import section, but keep imports grouped). Add:

```ts
import { parseJsonBody, mergeHeaders } from '@vnext/shared-http'
```

- [ ] **Step 2: Delete the two local function definitions**

In `vnext/packages/provider-copilot/src/provider.ts`, find and **delete** the two function blocks at lines 296-314:

```ts
function parseJsonBody(body: RequestInit['body'] | null | undefined): Record<string, unknown> {
  if (typeof body !== 'string') {
    throw new Error('CopilotProvider.fetch: body must be a JSON string')
  }
  return JSON.parse(body) as Record<string, unknown>
}

function mergeHeaders(
  initHeaders: RequestInit['headers'] | undefined,
  extra: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  if (initHeaders) {
    const h = new Headers(initHeaders)
    h.forEach((v, k) => { out[k] = v })
  }
  if (extra) Object.assign(out, extra)
  return out
}
```

Keep the other two local helpers (`readsStream`, `buildExtraHeaders`) — they are copilot-specific, not transport.

> **Note on error message:** the inline `parseJsonBody` throws `"CopilotProvider.fetch: body must be a JSON string"`; the shared one throws `"parseJsonBody: body must be a JSON string"`. The message is only ever surfaced to internal callers and is never returned to clients. Acceptable drift; do not add a wrapper.

- [ ] **Step 3: Typecheck + run all copilot tests**

Run:
```bash
cd /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/provider-copilot
bun run typecheck
bun test
```
Expected: typecheck passes (no unused-function warnings since strict mode flags unused imports, not unused functions in our config). All copilot tests pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/zhangxian/projects/copilot-api-gateway
git add vnext/packages/provider-copilot/src/provider.ts
git commit -m "refactor(vnext/provider-copilot): import parseJsonBody/mergeHeaders from @vnext/shared-http

Removes the two inline definitions in provider.ts. Behavior unchanged
(the moved code is byte-identical, only the parseJsonBody error
message prefix changes from 'CopilotProvider.fetch:' to 'parseJsonBody:',
which is internal-only)."
```

---

## Task 8: Full vNext typecheck + smoke

**Files:** none modified — verification only.

- [ ] **Step 1: Run workspace-wide typecheck**

Run from `/Users/zhangxian/projects/copilot-api-gateway/vnext`:
```bash
bun run typecheck
```
Expected: every workspace package (`@vnext/shared-http`, `@vnext/provider-copilot`, gateway app, etc.) passes typecheck.

- [ ] **Step 2: Run full vNext test suite**

Run from `/Users/zhangxian/projects/copilot-api-gateway/vnext`:
```bash
bun test
```
Expected: full pass — `@vnext/shared-http` tests (16) and existing `@vnext/provider-copilot` tests all green; no regressions in gateway app tests.

- [ ] **Step 3: Spot-check the empty `lib/` dir**

Run:
```bash
ls /Users/zhangxian/projects/copilot-api-gateway/vnext/packages/provider-copilot/src/lib/
```
Expected output: `error.ts` only. (The `fetch-retry.ts` removal from Task 5 should leave `error.ts` as the lone resident; don't remove or rename it — `HTTPError` still imports from there.)

- [ ] **Step 4: No commit needed — verification only**

If steps 1-3 all pass, plan1 is complete. Move on to plan2/plan3.

---

## Acceptance (recap from spec §7)

- `bun test` green for `@vnext/shared-http` (16 cases) and `@vnext/provider-copilot` (no regressions).
- `bun run typecheck` green workspace-wide.
- **Copilot behavior zero diff** — same retry curve, same timeout error message, same header merge semantics, same 200-char error truncate.
- No gateway file touched.
- `@vnext/shared-http` ready to be imported by plan2 (`@vnext/provider-custom`) and plan3 (`@vnext/provider-azure`).

---

## Plan Self-Review

**Spec coverage:**
- §3.1 package structure (shared-http package, copilot package modifications): ✅ Tasks 1-7
- §3.2 shared-http API (fetchWithRetry, mergeHeaders, parseJsonBody, truncateBody): ✅ Tasks 2-4
- §5 test strategy for shared-http (fetchWithRetry retry+timeout, mergeHeaders override, parseJsonBody/truncateBody): ✅ Tasks 2-4 — all listed cases covered. **Header merge priority** (extra > init > auth) is enforceable here for the `mergeHeaders` half (test 3 in Task 3); the auth-header layer (defaultHeaders > Authorization) is provider-business and gets locked in plan2/plan3 provider tests, not in plan1.
- §7 zero-diff acceptance: ✅ Task 8 final smoke + Task 5/6/7 per-step copilot test run.
- §8 plan1 prerequisite, no wiring: ✅ no gateway file touched.

**Placeholder scan:** none — every step has either complete code or an exact command with expected output.

**Type consistency:**
- `FetchOptions` name/shape matches between Task 2 source and Task 5/6 importer.
- `mergeHeaders(initHeaders, extra)` signature matches between Task 3 source and Task 7 deletion target.
- `parseJsonBody(body)` signature matches between Task 4 source and Task 7 deletion target (param type widened from `RequestInit['body']` to `BodyInit | null | undefined` — strictly compatible since `RequestInit['body'] = BodyInit | null`).
- `truncateBody(s, max=200)` matches the inline `errorBody.length > 200 ? errorBody.slice(0,200) + "...(truncated)" : errorBody` pattern in Task 6 byte-for-byte.

No gaps found.
