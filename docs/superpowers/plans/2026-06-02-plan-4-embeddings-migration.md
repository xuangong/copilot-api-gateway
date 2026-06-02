# Plan 4: embeddings Caller Migration + ModelEndpoint Alias Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the last `provider.callEmbeddings(payload, opts)` callsite to `provider.fetch("embeddings", ...)`, delete the `callEmbeddings` wrapper from all 4 places (interface + 3 providers), then drop the deprecated `ModelEndpoint` type alias and switch all consumers to `EndpointKey`.

**Architecture:** Same mechanical migration recipe as Plans 1–3, applied to `/embeddings`. After Task 4 the `ModelProvider` interface contains only `fetch()` + `supportedEndpoints`. Tasks 5–7 perform the final cleanup: rename all `ModelEndpoint` imports/annotations to `EndpointKey` and delete the deprecated alias from `src/protocols/common/index.ts`. This is a pure-rename operation with no behavioral changes.

**Tech Stack:** Bun runtime + TypeScript. One production caller (`src/routes/embeddings.ts`). One test (`tests/custom-provider.test.ts`). ~8 files reference `ModelEndpoint` and need rename.

---

## File Structure

**Caller files modified (production, 1 file, 1 callsite):**
- `src/routes/embeddings.ts:59` — only production callEmbeddings callsite

**Test files modified (2 files):**
- `tests/custom-provider.test.ts:67` — direct `p.callEmbeddings(...)` call
- `tests/provider-binding.test.ts:13` — delete `callEmbeddings` from inline mock

**Files modified (interface + providers, 4 files):**
- `src/providers/types.ts` — delete `callEmbeddings` line from `ModelProvider`
- `src/providers/copilot/provider.ts:60` — delete wrapper
- `src/providers/custom/provider.ts:128` — delete wrapper
- `src/providers/azure/provider.ts:135` — delete wrapper

**Files modified (rename `ModelEndpoint` → `EndpointKey`, ~8 files):**
- `src/protocols/common/index.ts` — delete the deprecated `ModelEndpoint = EndpointKey` alias
- `src/providers/binding.ts`
- `src/providers/registry.ts`
- `src/providers/planner.ts`
- `src/providers/azure/provider.ts`
- `src/providers/custom/provider.ts`
- `src/lib/binding-resolver.ts`
- `src/routes/control-plane.ts`

**Untouched:**
- `src/protocols/common/index.ts`'s `EndpointKey` type + `ALL_ENDPOINT_KEYS` const stay (canonical names from Plan 0).

---

## Migration Recipe

Same as previous plans.

**Before:**
```ts
const response = await provider.callEmbeddings(
  payload as unknown as Record<string, unknown>,
  { operationName: "create embeddings" },
)
```

**After:**
```ts
const response = await provider.fetch(
  "embeddings",
  { method: "POST", body: JSON.stringify(payload) },
  { operationName: "create embeddings" },
)
```

---

## Task 1: Migrate src/routes/embeddings.ts

**Files:**
- Modify: `src/routes/embeddings.ts:59`

- [ ] **Step 1: Read lines 55-65 to capture the exact call shape**

Run: `sed -n '55,65p' src/routes/embeddings.ts`

- [ ] **Step 2: Apply transform**

Replace:

```ts
  const response = await binding.provider.callEmbeddings(
    body as unknown as Record<string, unknown>,
    { operationName: "create embeddings" },
  )
```

with:

```ts
  const response = await binding.provider.fetch(
    "embeddings",
    { method: "POST", body: JSON.stringify(body) },
    { operationName: "create embeddings" },
  )
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/routes/embeddings.ts
git commit -m "refactor(embeddings): dispatch via provider.fetch('embeddings', ...)"
```

---

## Task 2: Migrate tests/custom-provider.test.ts direct call

**Files:**
- Modify: `tests/custom-provider.test.ts:67`

- [ ] **Step 1: Read lines 60-72 to see the assertion shape**

Run: `sed -n '60,72p' tests/custom-provider.test.ts`

- [ ] **Step 2: Replace the direct callEmbeddings call**

Replace:

```ts
    await p.callEmbeddings({ input: "hi" })
```

with:

```ts
    await p.fetch("embeddings", { method: "POST", body: JSON.stringify({ input: "hi" }) })
```

- [ ] **Step 3: Run the test**

Run: `bun test tests/custom-provider.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/custom-provider.test.ts
git commit -m "test(custom-provider): migrate embeddings assertion to fetch() surface"
```

---

## Task 3: Update tests/provider-binding.test.ts inline mock

**Files:**
- Modify: `tests/provider-binding.test.ts:13`

- [ ] **Step 1: Delete the `callEmbeddings` entry**

After Plans 1–3 the mock should look like:

```ts
{
  ...
  fetch: () => Promise.resolve(new Response()),
  callEmbeddings: () => Promise.resolve(new Response()),
}
```

Delete the `callEmbeddings` line so only `fetch` remains.

- [ ] **Step 2: Run binding test**

Run: `bun test tests/provider-binding.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/provider-binding.test.ts
git commit -m "test(provider-binding): remove callEmbeddings entry from inline mock"
```

---

## Task 4: Delete callEmbeddings wrapper from interface + 3 providers

**Files:**
- Modify: `src/providers/types.ts:43`
- Modify: `src/providers/copilot/provider.ts:60`
- Modify: `src/providers/custom/provider.ts:128`
- Modify: `src/providers/azure/provider.ts:135`

- [ ] **Step 1: Grep to confirm zero remaining callsites**

Run: `grep -rn "callEmbeddings" /Users/zhangxian/projects/copilot-api-gateway/src /Users/zhangxian/projects/copilot-api-gateway/tests`
Expected: Only the 4 declarations (interface + 3 providers).

- [ ] **Step 2: Delete from interface (`src/providers/types.ts`)**

Delete the line:

```ts
  /** @deprecated Use fetch('embeddings', ...). Removed in Plan 4. */
  callEmbeddings(payload: Record<string, unknown>, opts?: ProviderCallOptions): Promise<Response>
```

- [ ] **Step 3: Delete from CopilotProvider (`src/providers/copilot/provider.ts`)**

Delete the 3-line wrapper:

```ts
  callEmbeddings(payload: Record<string, unknown>, opts: ProviderCallOptions = {}): Promise<Response> {
    return this.fetch("embeddings", { method: "POST", body: JSON.stringify(payload) }, opts)
  }
```

- [ ] **Step 4: Delete from CustomProvider (`src/providers/custom/provider.ts`)**

Same 3-line delete.

- [ ] **Step 5: Delete from AzureProvider (`src/providers/azure/provider.ts`)**

Same 3-line delete.

- [ ] **Step 6: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors. The `ModelProvider` interface should now have only `supportedEndpoints` + `fetch`.

- [ ] **Step 7: Commit**

```bash
git add src/providers/types.ts src/providers/copilot/provider.ts src/providers/custom/provider.ts src/providers/azure/provider.ts
git commit -m "refactor(providers): remove callEmbeddings wrapper

ModelProvider interface is now capability-declarative:
only supportedEndpoints + fetch(endpoint, init, opts) remain.
All five callXxx wrappers (Plans 1-4) have been removed."
```

---

## Task 5: Rename ModelEndpoint → EndpointKey in src/ files (non-deprecated alias consumers)

**Files (8):**
- Modify: `src/providers/binding.ts:16,49,61,71`
- Modify: `src/providers/registry.ts:5,31,144`
- Modify: `src/providers/planner.ts:17,43`
- Modify: `src/providers/azure/provider.ts:18,39,51,57,65,154,176` (already updated in Task 4; rename remaining type uses)
- Modify: `src/providers/custom/provider.ts:14,34,50,55` (already updated in Task 4)
- Modify: `src/lib/binding-resolver.ts:4,52,134`
- Modify: `src/routes/control-plane.ts:15,47,72,76,77`

- [ ] **Step 1: Survey current `ModelEndpoint` references**

Run: `grep -rn "ModelEndpoint" /Users/zhangxian/projects/copilot-api-gateway/src`
Expected: ~20 hits across the 7 src files listed plus the `protocols/common/index.ts` definition.

- [ ] **Step 2: Sed-rename across each file**

For each file in the list above, replace `ModelEndpoint` with `EndpointKey`. Use `sed -i ''` per file (macOS BSD sed):

```bash
for f in \
  src/providers/binding.ts \
  src/providers/registry.ts \
  src/providers/planner.ts \
  src/providers/azure/provider.ts \
  src/providers/custom/provider.ts \
  src/lib/binding-resolver.ts \
  src/routes/control-plane.ts; do
  sed -i '' 's/\bModelEndpoint\b/EndpointKey/g' "$f"
done
```

This rewrites both import statements (`import type { ModelEndpoint }` → `import type { EndpointKey }`) and type annotations.

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors. (`ModelEndpoint` is still exported as an alias at this point, so even any missed reference would still compile — but the sed pass should catch them all.)

- [ ] **Step 4: Verify no stray ModelEndpoint references in src/ outside the alias definition**

Run: `grep -rn "ModelEndpoint" /Users/zhangxian/projects/copilot-api-gateway/src`
Expected: Only `src/protocols/common/index.ts` (the deprecated alias declaration itself).

- [ ] **Step 5: Commit**

```bash
git add src/providers src/lib/binding-resolver.ts src/routes/control-plane.ts
git commit -m "refactor(types): rename ModelEndpoint -> EndpointKey across src/

Mechanical rename. The deprecated alias in src/protocols/common
is removed in the next commit."
```

---

## Task 6: Rename ModelEndpoint → EndpointKey in tests/ (if any)

**Files:**
- Modify: any test file still referencing `ModelEndpoint`

- [ ] **Step 1: Survey**

Run: `grep -rn "ModelEndpoint" /Users/zhangxian/projects/copilot-api-gateway/tests`
Expected: 0 hits (current grep shows none). If hits appear, sed-rename them the same way as Task 5.

- [ ] **Step 2: If files were modified, typecheck and commit**

```bash
bunx tsc --noEmit
git add tests
git commit -m "test: rename ModelEndpoint -> EndpointKey in tests"
```

If grep is empty, skip this task with no commit.

---

## Task 7: Delete the deprecated ModelEndpoint alias

**Files:**
- Modify: `src/protocols/common/index.ts`

- [ ] **Step 1: Confirm no remaining `ModelEndpoint` references**

Run: `grep -rn "\bModelEndpoint\b" /Users/zhangxian/projects/copilot-api-gateway/src /Users/zhangxian/projects/copilot-api-gateway/tests`
Expected: Only `src/protocols/common/index.ts` (the alias declaration).

- [ ] **Step 2: Delete the alias**

Open `src/protocols/common/index.ts` and remove these lines (added in Plan 0):

```ts
/**
 * @deprecated Use `EndpointKey` instead. This alias exists for migration only
 * and will be removed in Plan 4.
 */
export type ModelEndpoint = EndpointKey
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Full curated test suite**

Run:

```bash
bun test tests/transforms.test.ts tests/formatter.test.ts tests/storage.test.ts tests/error.test.ts tests/interceptor.test.ts tests/provider-capability.test.ts tests/endpoint-key.test.ts tests/provider-binding.test.ts tests/provider-probe.test.ts tests/azure-provider.test.ts tests/custom-provider.test.ts tests/copilot-provider-variant.test.ts tests/chat-completions-stream-usage.test.ts tests/responses-stream-usage.test.ts tests/messages-gpt-stream-usage.test.ts tests/gemini-stream-usage.test.ts
```

Expected: All PASS.

- [ ] **Step 5: Commit**

```bash
git add src/protocols/common/index.ts
git commit -m "refactor(types): drop deprecated ModelEndpoint alias

EndpointKey is now the single canonical name.
Closes the Plan 0 -> Plan 4 migration cycle."
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Single embeddings production callsite migrated — Task 1
- ✅ custom-provider direct call migrated — Task 2
- ✅ provider-binding inline mock updated — Task 3
- ✅ `callEmbeddings` removed from interface + 3 providers — Task 4
- ✅ `ModelEndpoint` renamed to `EndpointKey` across src/ — Task 5
- ✅ `ModelEndpoint` renamed in tests/ (if any) — Task 6
- ✅ Deprecated alias deleted — Task 7
- ✅ Full curated suite re-run — Task 7 Step 4

**Placeholder scan:**
- Task 6 has an explicit `if grep is empty, skip` branch — concrete conditional, not a TODO. Current grep already shows zero test references so this task will likely be a no-op.

**Type consistency:**
- All `fetch()` calls use literal `"embeddings"`.
- `init.body` is `JSON.stringify(payload)`.
- Test mock removal is consistent with Plans 1–3 (delete-the-line pattern).
- After Task 7, `EndpointKey` is the sole exported endpoint type name.

---

## After Plan 4 lands

`ModelProvider` is now:

```ts
interface ModelProvider {
  readonly name: string
  readonly supportedEndpoints: readonly EndpointKey[]
  fetch(endpoint: EndpointKey, init: RequestInit, opts?: ProviderFetchOptions): Promise<Response>
}
```

— no more `callXxx` methods, no more deprecated alias. The interface matches the reference `copilot-gateway` shape.

Next: **Plan 5** — add new image endpoints (`images_generations` + `images_edits`) for Custom + Azure providers. Copilot stays out (it doesn't expose images). Touches `EndpointKey` union, both providers' path tables, and adds new routes under `src/routes/images/`.
