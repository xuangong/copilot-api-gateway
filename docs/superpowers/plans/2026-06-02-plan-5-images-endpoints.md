# Plan 5: Image Endpoints (images_generations + images_edits) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two new OpenAI-shape image endpoints — `images_generations` (text → image, JSON body) and `images_edits` (image + mask → image, multipart body) — to the `EndpointKey` union, Custom + Azure providers' path tables, and the public API surface. Copilot is intentionally excluded because GitHub Copilot does not expose image APIs.

**Architecture:** Pure additive change on top of the Plan 0–4 capability-declarative stack. Both endpoints reuse the existing `provider.fetch(endpoint, init, opts)` dispatch path. `images_generations` sends `application/json`; `images_edits` sends `multipart/form-data` and the route forwards `ctx.request.body` (the original `FormData` or raw multipart stream) verbatim so we don't re-encode files. Custom + Azure providers add path entries; Copilot's `supportedEndpoints` does NOT grow, so `bindingsForEndpoint()` will simply filter Copilot out for image requests — a 404 falls out automatically when no upstream serves the endpoint.

**Tech Stack:** Bun runtime + TypeScript. New file `src/routes/images.ts`. Modifies `src/protocols/common/index.ts`, `src/routes/control-plane.ts`, `src/providers/custom/provider.ts`, `src/providers/azure/provider.ts`, `src/index.ts`, `src/local.ts`. New test file `tests/images-routes.test.ts`.

---

## File Structure

**Files created (2):**
- `src/routes/images.ts` — Elysia route module exporting `imagesRoute`. Mounts `POST /images/generations`, `POST /v1/images/generations`, `POST /images/edits`, `POST /v1/images/edits`.
- `tests/images-routes.test.ts` — happy-path + 404 + multipart-passthrough tests using a mocked provider.

**Files modified (7):**
- `src/protocols/common/index.ts` — extend `EndpointKey` union and `ALL_ENDPOINT_KEYS` with `"images_generations"` and `"images_edits"`.
- `src/routes/control-plane.ts` — extend the `ENDPOINTS` Set with the two new literals so admins can configure them per-upstream.
- `src/providers/custom/provider.ts` — add `"images_generations": "/images/generations"` and `"images_edits": "/images/edits"` to `CUSTOM_PATHS` (Plan 0's path table).
- `src/providers/azure/provider.ts` — add the two endpoints to `OPENAI_PATHS` (Azure deployments serve images under `/openai/deployments/<name>/images/{generations,edits}?api-version=…`).
- `src/routes/index.ts` — re-export `imagesRoute`.
- `src/index.ts` — `.use(imagesRoute)`.
- `src/local.ts` — `.use(imagesRoute)`.

**Untouched (intentionally):**
- `src/providers/copilot/provider.ts` — Copilot doesn't serve images; `supportedEndpoints` deliberately excludes them.
- `src/lib/binding-resolver.ts` — already endpoint-agnostic; no change needed.
- All `callXxx`-related plumbing — removed in Plans 1–4, so this plan only adds endpoints to the new surface.

---

## Endpoint Spec

**`POST /v1/images/generations`**

OpenAI-compatible. JSON body:

```json
{
  "model": "dall-e-3",
  "prompt": "an astronaut riding a horse",
  "n": 1,
  "size": "1024x1024",
  "response_format": "url"
}
```

Response: forwarded verbatim from upstream (JSON `{ created, data: [...] }`).

**`POST /v1/images/edits`**

OpenAI-compatible. `multipart/form-data`:

```
image: (file)
mask:  (file, optional)
prompt: "..."
model: "dall-e-2"
n: 1
size: "1024x1024"
```

Response: forwarded verbatim from upstream.

For both, the route resolves the binding via `model`, then calls `binding.provider.fetch(endpoint, init, opts)` where `init` carries the body and the right `Content-Type`.

---

## Task 1: Extend EndpointKey + ALL_ENDPOINT_KEYS

**Files:**
- Modify: `src/protocols/common/index.ts`

- [ ] **Step 1: Write the failing test**

File: `tests/endpoint-key.test.ts` (extend if exists, otherwise create — Plan 0 added a similar test).

Append:

```ts
test("EndpointKey includes images_generations and images_edits", () => {
  const keys: EndpointKey[] = [
    "chat_completions", "responses", "messages",
    "messages_count_tokens", "embeddings",
    "images_generations", "images_edits",
  ]
  for (const k of keys) {
    expect(ALL_ENDPOINT_KEYS).toContain(k)
  }
  expect(ALL_ENDPOINT_KEYS.length).toBe(7)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/endpoint-key.test.ts`
Expected: FAIL — type error / length mismatch.

- [ ] **Step 3: Extend the union and runtime list**

In `src/protocols/common/index.ts`, change:

```ts
export type EndpointKey =
  | "chat_completions"
  | "responses"
  | "messages"
  | "messages_count_tokens"
  | "embeddings"

export const ALL_ENDPOINT_KEYS = [
  "chat_completions",
  "responses",
  "messages",
  "messages_count_tokens",
  "embeddings",
] as const satisfies readonly EndpointKey[]
```

to:

```ts
export type EndpointKey =
  | "chat_completions"
  | "responses"
  | "messages"
  | "messages_count_tokens"
  | "embeddings"
  | "images_generations"
  | "images_edits"

export const ALL_ENDPOINT_KEYS = [
  "chat_completions",
  "responses",
  "messages",
  "messages_count_tokens",
  "embeddings",
  "images_generations",
  "images_edits",
] as const satisfies readonly EndpointKey[]
```

- [ ] **Step 4: Typecheck + re-run test**

```bash
bunx tsc --noEmit
bun test tests/endpoint-key.test.ts
```

Expected: 0 errors, test PASS.

- [ ] **Step 5: Commit**

```bash
git add src/protocols/common/index.ts tests/endpoint-key.test.ts
git commit -m "feat(types): add images_generations + images_edits to EndpointKey"
```

---

## Task 2: Extend control-plane ENDPOINTS set

**Files:**
- Modify: `src/routes/control-plane.ts:47`

- [ ] **Step 1: Read line 47**

Run: `sed -n '40,55p' src/routes/control-plane.ts`

The current line should be:

```ts
const ENDPOINTS = new Set<EndpointKey>(["chat_completions", "responses", "messages", "messages_count_tokens", "embeddings"])
```

(After Plan 4 the type annotation is `EndpointKey`, not `ModelEndpoint`.)

- [ ] **Step 2: Add the two new literals**

Replace with:

```ts
const ENDPOINTS = new Set<EndpointKey>([
  "chat_completions",
  "responses",
  "messages",
  "messages_count_tokens",
  "embeddings",
  "images_generations",
  "images_edits",
])
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/routes/control-plane.ts
git commit -m "feat(control-plane): allow images_* in per-upstream endpoint config"
```

---

## Task 3: Add image paths to CustomProvider

**Files:**
- Modify: `src/providers/custom/provider.ts` (after Plan 0 + Plan 4 cleanup the path table is named `CUSTOM_PATHS`)

- [ ] **Step 1: Locate the path table**

Run: `grep -n "CUSTOM_PATHS\|chat_completions.*:" src/providers/custom/provider.ts | head -10`
Confirm `CUSTOM_PATHS` is a `Record<EndpointKey, string>` (Plan 0 sets it up).

- [ ] **Step 2: Add image paths**

In `CUSTOM_PATHS`, add the two entries (keep alphabetic-ish order matching existing style):

```ts
const CUSTOM_PATHS: Record<EndpointKey, string> = {
  chat_completions: "/chat/completions",
  responses: "/responses",
  messages: "/messages",
  messages_count_tokens: "/messages/count_tokens",
  embeddings: "/embeddings",
  images_generations: "/images/generations",
  images_edits: "/images/edits",
}
```

If TypeScript complains that `CUSTOM_PATHS` was typed as `Partial<Record<EndpointKey, string>>` (acceptable post-Plan-0 shape), upgrade to a complete `Record<EndpointKey, string>` since we now serve every key. Otherwise keep `Partial<...>` and just add the entries.

- [ ] **Step 3: Update DEFAULT_ENDPOINTS comment (if it claims a fixed list)**

Search:

```bash
grep -n "DEFAULT_ENDPOINTS" src/providers/custom/provider.ts
```

If the file has:

```ts
const DEFAULT_ENDPOINTS: readonly EndpointKey[] = ["chat_completions", "embeddings"]
```

Leave it as-is. Image endpoints must be **opt-in per upstream** via `endpoints: [...]` config — Custom providers vary wildly (DeepSeek doesn't serve images, OpenAI proper does).

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/providers/custom/provider.ts
git commit -m "feat(custom-provider): add images_generations + images_edits paths"
```

---

## Task 4: Add image paths to AzureProvider

**Files:**
- Modify: `src/providers/azure/provider.ts` (lines around 51 — `OPENAI_PATHS`)

- [ ] **Step 1: Read OPENAI_PATHS region**

Run: `sed -n '48,65p' src/providers/azure/provider.ts`

After Plan 0–4 it looks like:

```ts
const OPENAI_PATHS: Partial<Record<EndpointKey, string>> = {
  chat_completions: "/chat/completions",
  responses: "/responses",
  embeddings: "/embeddings",
}
```

- [ ] **Step 2: Add the two entries**

Append:

```ts
const OPENAI_PATHS: Partial<Record<EndpointKey, string>> = {
  chat_completions: "/chat/completions",
  responses: "/responses",
  embeddings: "/embeddings",
  images_generations: "/images/generations",
  images_edits: "/images/edits",
}
```

`ANTHROPIC_PATHS` is untouched — Anthropic deployments don't serve images.

The deployment URL builder (`buildUrl`) is generic over `OPENAI_PATHS`, so no other changes are needed: `${endpoint}/openai/deployments/${deployment}/images/generations?api-version=…` falls out automatically.

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/providers/azure/provider.ts
git commit -m "feat(azure-provider): add images_generations + images_edits paths"
```

---

## Task 5: Create src/routes/images.ts (JSON + multipart routes)

**Files:**
- Create: `src/routes/images.ts`

- [ ] **Step 1: Write the route file**

Create `src/routes/images.ts` with this content:

```ts
import { Elysia } from "elysia"

import { resolveBinding, stripUpstreamPin } from "~/lib/binding-resolver"
import { detectClient } from "~/lib/client-detect"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { checkQuota } from "~/lib/quota"
import type { AppState } from "~/lib/state"
import type { EndpointKey } from "~/protocols/common"

interface GenerationsPayload {
  model: string
  prompt?: string
  n?: number
  size?: string
  response_format?: string
  user?: string
}

interface ImagesRouteContext {
  state: AppState
  body: GenerationsPayload | unknown
  request: Request
  apiKeyId?: string
  colo: string
  requestId?: string
  userAgent?: string
  userId?: string
}

async function rateLimitGuard(apiKeyId: string | undefined): Promise<Response | null> {
  if (!apiKeyId) return null
  const quota = await checkQuota(apiKeyId)
  if (quota.allowed) return null
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (quota.retryAfterSeconds) headers["Retry-After"] = String(quota.retryAfterSeconds)
  return new Response(
    JSON.stringify({ error: { type: "rate_limit_error", message: quota.reason } }),
    { status: 429, headers },
  )
}

async function handleGenerations(ctx: ImagesRouteContext): Promise<Response> {
  const { state, body, apiKeyId, colo, requestId, userAgent } = ctx
  const elapsed = startTimer()
  const client = detectClient(userAgent)

  const rejected = await rateLimitGuard(apiKeyId)
  if (rejected) return rejected

  const payload = body as GenerationsPayload
  if (!payload || typeof payload.model !== "string") {
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: "model is required" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )
  }

  stripUpstreamPin(payload as unknown as Record<string, unknown>)
  const binding = await resolveBinding(state, ctx.userId, payload.model, "images_generations")
  if (!binding) {
    return new Response(
      JSON.stringify({
        error: { type: "invalid_request_error", message: `No images_generations upstream available for model: ${payload.model}. Run GET /v1/models for available ids.` },
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  }

  const upstreamTimer = startTimer()
  const response = await binding.provider.fetch(
    "images_generations" as EndpointKey,
    { method: "POST", body: JSON.stringify(payload) },
    { operationName: "create image" },
  )
  const upstreamMs = upstreamTimer()

  // Images responses don't carry token usage — record only latency, no usage tracking.
  if (apiKeyId) {
    recordLatency(apiKeyId, payload.model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: 0,
      outputTokens: 0,
      sourceApi: "images_generations",
      targetApi: "images_generations",
      upstream: binding.upstream,
    }).catch(() => {})
  }

  // Forward raw response (status + headers + body) so the caller sees what upstream sent.
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  })
}

async function handleEdits(ctx: ImagesRouteContext): Promise<Response> {
  const { state, request, apiKeyId, colo, requestId, userAgent } = ctx
  const elapsed = startTimer()
  const client = detectClient(userAgent)

  const rejected = await rateLimitGuard(apiKeyId)
  if (rejected) return rejected

  // Re-read multipart so we can extract `model` without consuming the original body twice.
  // Buffer the raw bytes once, then parse for routing and forward to upstream.
  const contentType = request.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: "/images/edits requires multipart/form-data" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )
  }

  // Bun's Request supports formData() and we can rebuild a fresh body for the upstream call.
  // formData() consumes the body, so we reconstruct a FormData when forwarding.
  let form: FormData
  try {
    form = await request.formData()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: `failed to parse multipart: ${msg}` } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )
  }

  const modelField = form.get("model")
  const model = typeof modelField === "string" ? modelField : null
  if (!model) {
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: "model field is required in multipart body" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )
  }

  const binding = await resolveBinding(state, ctx.userId, model, "images_edits")
  if (!binding) {
    return new Response(
      JSON.stringify({
        error: { type: "invalid_request_error", message: `No images_edits upstream available for model: ${model}. Run GET /v1/models for available ids.` },
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  }

  // Forward the FormData verbatim. fetch() will set Content-Type with the correct boundary.
  const upstreamTimer = startTimer()
  const response = await binding.provider.fetch(
    "images_edits" as EndpointKey,
    { method: "POST", body: form },
    { operationName: "edit image" },
  )
  const upstreamMs = upstreamTimer()

  if (apiKeyId) {
    recordLatency(apiKeyId, model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: 0,
      outputTokens: 0,
      sourceApi: "images_edits",
      targetApi: "images_edits",
      upstream: binding.upstream,
    }).catch(() => {})
  }

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  })
}

export const imagesRoute = new Elysia()
  .post("/images/generations", (ctx) => handleGenerations(ctx as unknown as ImagesRouteContext))
  .post("/v1/images/generations", (ctx) => handleGenerations(ctx as unknown as ImagesRouteContext))
  .post("/images/edits", (ctx) => handleEdits(ctx as unknown as ImagesRouteContext))
  .post("/v1/images/edits", (ctx) => handleEdits(ctx as unknown as ImagesRouteContext))
```

**Why this shape:**
- `handleGenerations` mirrors `src/routes/embeddings.ts` almost exactly — same quota guard, same binding lookup, same `provider.fetch()` call. Only difference: no token-usage tracking (images have no token semantics).
- `handleEdits` reads the multipart body, extracts `model` for binding routing, then re-forwards as `FormData` (Bun `fetch` regenerates the boundary). The provider's `fetch()` does NOT override `Content-Type` when `body` is a `FormData` — it relies on the runtime's auto-set boundary.

**Provider fetch() must NOT force `Content-Type: application/json` for FormData bodies.** Verify this in Task 6.

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/routes/images.ts
git commit -m "feat(images): add /images/{generations,edits} routes via provider.fetch()"
```

---

## Task 6: Make provider fetch() Content-Type-aware for FormData bodies

**Files:**
- Modify: `src/providers/custom/provider.ts` (private headers/post helper)
- Modify: `src/providers/azure/provider.ts` (private headers helper)

**Why:** Plan 0's `fetch()` implementations set `Content-Type: application/json` unconditionally inside their internal `headers()` helpers. That breaks multipart — `body: FormData` needs the runtime to set `multipart/form-data; boundary=…`. We must skip forcing JSON when `init.body` is a `FormData`.

- [ ] **Step 1: Write the failing test**

File: `tests/images-content-type.test.ts` (new).

```ts
import { describe, test, expect, beforeEach, mock } from "bun:test"

let captured: { url: string; init: RequestInit } | null = null
mock.module("~/lib/fetch-retry", () => ({
  fetchWithRetry: async (url: string, init: RequestInit) => {
    captured = { url, init }
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
  },
}))

import { CustomProvider } from "~/providers/custom/provider"

describe("CustomProvider.fetch — FormData body", () => {
  beforeEach(() => { captured = null })

  test("does NOT force Content-Type: application/json when body is FormData", async () => {
    const p = new CustomProvider({
      name: "x",
      baseUrl: "https://x",
      apiKey: "k",
      endpoints: ["images_edits"],
    })
    const fd = new FormData()
    fd.append("model", "dall-e-2")
    fd.append("prompt", "hi")
    await p.fetch("images_edits", { method: "POST", body: fd })
    const headers = captured!.init.headers as Record<string, string>
    expect(headers["Content-Type"]).toBeUndefined()
    // Authorization must still be set.
    expect(headers.Authorization).toBe("Bearer k")
  })

  test("still sets Content-Type: application/json when body is a string", async () => {
    const p = new CustomProvider({
      name: "x",
      baseUrl: "https://x",
      apiKey: "k",
      endpoints: ["chat_completions"],
    })
    await p.fetch("chat_completions", { method: "POST", body: JSON.stringify({ model: "m" }) })
    const headers = captured!.init.headers as Record<string, string>
    expect(headers["Content-Type"]).toBe("application/json")
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/images-content-type.test.ts`
Expected: First test FAILS — `Content-Type` is `"application/json"`, expected undefined.

- [ ] **Step 3: Patch CustomProvider's authHeaders / fetch path**

In `src/providers/custom/provider.ts`, locate the `authHeaders` helper and the place where it's called from `fetch()`/`post()`. Change the call site so JSON content-type is conditional on body type:

```ts
private authHeaders(
  extra: Record<string, string> = {},
  opts: { includeJsonContentType?: boolean } = {},
): Record<string, string> {
  const base: Record<string, string> = {
    "Authorization": `Bearer ${this.apiKey}`,
    ...this.defaultHeaders,
    ...extra,
  }
  if (opts.includeJsonContentType !== false) {
    base["Content-Type"] = "application/json"
  }
  return base
}
```

Then in the fetch dispatch (the unified post helper that handles all endpoints — Plan 0 introduced this), compute:

```ts
const bodyIsFormData = init.body instanceof FormData
const headers = this.authHeaders(init.headers as Record<string, string> ?? {}, {
  includeJsonContentType: !bodyIsFormData,
})
```

Adjust whatever helper signature already exists — the point is to NOT add `Content-Type: application/json` when `init.body` is `FormData`. (Also do not add it when caller explicitly set a different `Content-Type` in `init.headers` — preserve caller intent.)

- [ ] **Step 4: Same change for AzureProvider**

In `src/providers/azure/provider.ts`, the `headers()` private helper unconditionally sets `"Content-Type": "application/json"`. Modify identically:

```ts
private headers(
  extra: Record<string, string> = {},
  opts: { includeJsonContentType?: boolean } = {},
): Record<string, string> {
  const base: Record<string, string> = {
    "api-key": this.apiKey,
    ...this.defaultHeaders,
    ...extra,
  }
  if (opts.includeJsonContentType !== false) {
    base["Content-Type"] = "application/json"
  }
  return base
}
```

And in the fetch dispatch, compute `bodyIsFormData` and pass `{ includeJsonContentType: !bodyIsFormData }`.

Copilot provider is untouched — Copilot doesn't serve images, no FormData ever reaches it.

- [ ] **Step 5: Re-run tests**

Run: `bun test tests/images-content-type.test.ts`
Expected: All PASS.

- [ ] **Step 6: Re-run full provider test suite to confirm no regression**

Run: `bun test tests/azure-provider.test.ts tests/custom-provider.test.ts tests/copilot-provider-variant.test.ts`
Expected: All PASS — existing JSON callsites must still get `Content-Type: application/json`.

- [ ] **Step 7: Commit**

```bash
git add src/providers/custom/provider.ts src/providers/azure/provider.ts tests/images-content-type.test.ts
git commit -m "feat(providers): skip JSON Content-Type for FormData bodies

Required for /images/edits multipart upstreams. Existing JSON
endpoints keep application/json unchanged."
```

---

## Task 7: Mount imagesRoute in src/index.ts and src/local.ts

**Files:**
- Modify: `src/routes/index.ts`
- Modify: `src/index.ts:18` (imports) and `:473` (`.use(...)`)
- Modify: `src/local.ts:29` (imports) and `:612` (`.use(...)`)

- [ ] **Step 1: Re-export from routes barrel**

In `src/routes/index.ts` add:

```ts
export { imagesRoute } from "./images"
```

- [ ] **Step 2: Import + use in src/index.ts**

After the existing `embeddingsRoute` import (line 18), add:

```ts
import { imagesRoute } from "~/routes/images"
```

After `.use(embeddingsRoute)` (line 473), add:

```ts
    .use(imagesRoute)
```

- [ ] **Step 3: Import + use in src/local.ts**

Same two edits at lines 29 and 612 (mirror locations).

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/routes/index.ts src/index.ts src/local.ts
git commit -m "feat(server): mount imagesRoute on cfw + local entrypoints"
```

---

## Task 8: Write integration tests for the new routes

**Files:**
- Create: `tests/images-routes.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/images-routes.test.ts`:

```ts
import { describe, test, expect, beforeEach, mock } from "bun:test"

let upstreamCall: { endpoint: string; init: RequestInit } | null = null
let upstreamResponse: Response | null = null

mock.module("~/providers/registry", () => ({
  createCopilotProvider: () => ({
    supportedEndpoints: [],
    fetch: async () => { throw new Error("copilot should not be called for images") },
  }),
  listProviderBindings: async () => [
    {
      upstream: "up_test",
      model: { id: "dall-e-3" },
      provider: {
        supportedEndpoints: ["images_generations", "images_edits"],
        fetch: async (endpoint: string, init: RequestInit) => {
          upstreamCall = { endpoint, init }
          if (!upstreamResponse) throw new Error("missing upstreamResponse fixture")
          return upstreamResponse
        },
      },
    },
  ],
}))

import { imagesRoute } from "~/routes/images"
import { Elysia } from "elysia"

const app = new Elysia().use(imagesRoute)

describe("/v1/images/generations", () => {
  beforeEach(() => { upstreamCall = null; upstreamResponse = null })

  test("forwards JSON body via provider.fetch('images_generations', ...)", async () => {
    upstreamResponse = new Response(
      JSON.stringify({ created: 1, data: [{ url: "https://x/img.png" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
    const res = await app.handle(new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "dall-e-3", prompt: "a cat", n: 1 }),
    }))
    expect(res.status).toBe(200)
    expect(upstreamCall?.endpoint).toBe("images_generations")
    expect(upstreamCall?.init.method).toBe("POST")
    expect(typeof upstreamCall?.init.body).toBe("string")
    const json = JSON.parse(upstreamCall!.init.body as string)
    expect(json.model).toBe("dall-e-3")
    expect(json.prompt).toBe("a cat")
  })

  test("returns 404 when no upstream serves images_generations for the model", async () => {
    const res = await app.handle(new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "nonexistent-model", prompt: "hi" }),
    }))
    expect(res.status).toBe(404)
  })

  test("returns 400 when model is missing", async () => {
    const res = await app.handle(new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "no model" }),
    }))
    expect(res.status).toBe(400)
  })
})

describe("/v1/images/edits", () => {
  beforeEach(() => { upstreamCall = null; upstreamResponse = null })

  test("forwards multipart FormData via provider.fetch('images_edits', ...)", async () => {
    upstreamResponse = new Response(
      JSON.stringify({ created: 1, data: [{ url: "https://x/edited.png" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
    const fd = new FormData()
    fd.append("model", "dall-e-3")
    fd.append("prompt", "make it red")
    fd.append("image", new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), "image.png")
    const res = await app.handle(new Request("http://localhost/v1/images/edits", {
      method: "POST",
      body: fd,
    }))
    expect(res.status).toBe(200)
    expect(upstreamCall?.endpoint).toBe("images_edits")
    expect(upstreamCall?.init.body).toBeInstanceOf(FormData)
    const fwd = upstreamCall!.init.body as FormData
    expect(fwd.get("model")).toBe("dall-e-3")
    expect(fwd.get("prompt")).toBe("make it red")
    expect(fwd.get("image")).toBeInstanceOf(Blob)
  })

  test("returns 400 when content-type is not multipart", async () => {
    const res = await app.handle(new Request("http://localhost/v1/images/edits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "dall-e-3", prompt: "x" }),
    }))
    expect(res.status).toBe(400)
  })

  test("returns 400 when model field is missing", async () => {
    const fd = new FormData()
    fd.append("prompt", "no model here")
    const res = await app.handle(new Request("http://localhost/v1/images/edits", {
      method: "POST",
      body: fd,
    }))
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run to verify the test infrastructure works**

Run: `bun test tests/images-routes.test.ts`
Expected: All PASS once the route + path entries + provider fetch shim are in place (Tasks 1–6 complete).

If `resolveBinding` doesn't pick up the mocked `listProviderBindings`, check that the mock path matches the actual import path in `src/lib/binding-resolver.ts`. Adjust the `mock.module(...)` target accordingly.

- [ ] **Step 3: Commit**

```bash
git add tests/images-routes.test.ts
git commit -m "test(images): cover generations + edits routes (JSON + multipart)"
```

---

## Task 9: Final typecheck + curated suite

- [ ] **Step 1: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 2: Run the full curated test suite**

Run:

```bash
bun test tests/transforms.test.ts tests/formatter.test.ts tests/storage.test.ts tests/error.test.ts tests/interceptor.test.ts tests/provider-capability.test.ts tests/endpoint-key.test.ts tests/provider-binding.test.ts tests/provider-probe.test.ts tests/azure-provider.test.ts tests/custom-provider.test.ts tests/copilot-provider-variant.test.ts tests/chat-completions-stream-usage.test.ts tests/responses-stream-usage.test.ts tests/messages-gpt-stream-usage.test.ts tests/gemini-stream-usage.test.ts tests/images-content-type.test.ts tests/images-routes.test.ts
```

Expected: All PASS.

- [ ] **Step 3: No commit needed** (verification only)

---

## Self-Review Checklist

**Spec coverage:**
- ✅ `EndpointKey` extended (union + ALL_ENDPOINT_KEYS) — Task 1
- ✅ Control-plane ENDPOINTS set extended — Task 2
- ✅ CustomProvider path table extended — Task 3
- ✅ AzureProvider OPENAI_PATHS extended (Anthropic untouched) — Task 4
- ✅ New routes file with both JSON + multipart handlers — Task 5
- ✅ Provider header logic respects FormData bodies — Task 6
- ✅ Routes mounted on cfw + local entrypoints — Task 7
- ✅ Integration tests for JSON + multipart + 404 + 400 paths — Task 8
- ✅ Final typecheck + curated suite — Task 9
- ✅ Copilot intentionally excluded (no path entries, no test mock keys)

**Placeholder scan:**
- Task 3 mentions "after Plan 0 the path table is `CUSTOM_PATHS`" — concrete reference to a known structure, not a TODO.
- Task 6 says "the unified post helper that handles all endpoints — Plan 0 introduced this" — refers to existing code, not future work. Implementer reads the file before editing.
- Task 8 contains real test code with concrete assertions. The "Adjust the `mock.module(...)` target accordingly" sentence in Step 2 is a conditional fallback for mock-resolution mismatches, with a precise diagnostic ("doesn't pick up the mocked `listProviderBindings`") — acceptable.

**Type consistency:**
- All new keys use the exact literals `"images_generations"` and `"images_edits"` throughout (EndpointKey union, runtime list, control-plane set, both path tables, route file, both test files).
- `provider.fetch()` signature unchanged — no new options needed at the public API. The FormData handling is internal to each provider's header builder.
- Route file's `EndpointKey` import path matches Plan 4's canonical name (no `ModelEndpoint`).
- New tests use `bun:test` consistent with project convention.

---

## After Plan 5 lands

The provider surface is now:

```ts
interface ModelProvider {
  readonly name: string
  readonly supportedEndpoints: readonly EndpointKey[] // 7 possible values
  fetch(endpoint: EndpointKey, init: RequestInit, opts?: ProviderFetchOptions): Promise<Response>
}
```

Seven endpoints total: chat_completions, responses, messages, messages_count_tokens, embeddings, images_generations, images_edits.

Adding the next endpoint (audio? video? tts? whisper?) is now a 5-edit operation: union + ALL_ENDPOINT_KEYS + control-plane set + per-provider path entry + new route file. No interface churn, no migration plan needed.

This completes the 6-plan refactor cycle (Plans 0–5). The `ModelProvider` interface is now fully capability-declarative and additive-extensible.
