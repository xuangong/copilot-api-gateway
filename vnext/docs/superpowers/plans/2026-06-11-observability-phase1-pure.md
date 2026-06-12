# Observability — Phase 1: Pure Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the three pure (no-I/O) observability modules so they can be unit-tested in isolation: `client-detect.ts`, `usage-extractor.ts`, and the pure `computeWeightedTokens` helper that will live inside `quota.ts`.

**Architecture:** All three files go under `vnext/apps/gateway/src/shared/observability/`. They have no dependency on `getRepo()` and no side effects, so they ship with `bun:test` golden-input tests and zero infrastructure. A small re-export is added to `@vnext/provider-copilot` so usage-extractor can normalize Anthropic / Copilot model ids without reaching into deep internal paths.

**Tech Stack:** Bun, TypeScript, `bun:test`. No new dependencies.

**Spec reference:** `vnext/docs/superpowers/specs/2026-06-11-observability-layer-design.md` — modules 1, 3, and the `computeWeightedTokens` portion of module 5.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `vnext/apps/gateway/src/shared/observability/client-detect.ts` | UA → short SDK id mapping (port of `src/lib/client-detect.ts`) |
| `vnext/apps/gateway/src/shared/observability/usage-extractor.ts` | JSON + SSE usage parsers; pure model-id normalization helpers |
| `vnext/apps/gateway/src/shared/observability/quota-math.ts` | `computeWeightedTokens` weighted-sum formula |
| `vnext/apps/gateway/tests/observability/client-detect.test.ts` | Golden UAs |
| `vnext/apps/gateway/tests/observability/usage-extractor.test.ts` | Golden JSON + SSE frames |
| `vnext/apps/gateway/tests/observability/quota-math.test.ts` | Weighted-token formula |
| `vnext/packages/provider-copilot/src/index.ts` (modify) | Re-export `normalizeAnthropicVersion` + `copilotPublicModelId` |
| `vnext/packages/provider-copilot/package.json` (modify, optional) | (No change — exports `.` already covers the re-exports) |

`computeWeightedTokens` deliberately lives in its own `quota-math.ts` rather than inside the future `quota.ts`. Phase 1 stays pure; Phase 2 will add a `quota.ts` that calls `getRepo()` and re-exports the formula from here. Splitting like this keeps Phase 1 unit tests free of the repo dependency.

---

### Task 1: Create observability directory + provider-copilot re-export

**Why first:** every later task imports from these locations.

**Files:**
- Create: `vnext/apps/gateway/src/shared/observability/.gitkeep`
- Create: `vnext/apps/gateway/tests/observability/.gitkeep`
- Modify: `vnext/packages/provider-copilot/src/index.ts`

- [ ] **Step 1: Make the directories**

```bash
mkdir -p vnext/apps/gateway/src/shared/observability
mkdir -p vnext/apps/gateway/tests/observability
```

- [ ] **Step 2: Re-export the two model-id helpers from provider-copilot**

Open `vnext/packages/provider-copilot/src/index.ts`. Find the line:

```ts
export { parseCompositeModelId } from "./variants"
```

Replace with:

```ts
export { parseCompositeModelId, normalizeAnthropicVersion, copilotPublicModelId } from "./variants"
```

- [ ] **Step 3: Typecheck the workspace**

Run: `cd vnext && bun run -F '@vnext/provider-copilot' typecheck && bun run -F '@vnext/gateway' typecheck`
Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add vnext/packages/provider-copilot/src/index.ts vnext/apps/gateway/src/shared/observability vnext/apps/gateway/tests/observability
git commit -m "chore(gateway): scaffold observability dirs + re-export model-id helpers"
```

---

### Task 2: `client-detect.ts` — write the failing test

**Files:**
- Test: `vnext/apps/gateway/tests/observability/client-detect.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from 'bun:test'
import { detectClient } from '../../src/shared/observability/client-detect.ts'

test('detectClient: known clients', () => {
  expect(detectClient('claude-cli/1.0 (claude-code)')).toBe('claude-code')
  expect(detectClient('codex-cli/2.0')).toBe('codex-cli')
  expect(detectClient('Cursor/0.42 anthropic-typescript/0.30')).toBe('cursor')
  expect(detectClient('OpenAI/Python 1.55.0')).toBe('openai-sdk')
  expect(detectClient('python-requests/2.32')).toBe('python-requests')
})

test('detectClient: empty / null / undefined', () => {
  expect(detectClient('')).toBe('')
  expect(detectClient(null)).toBe('')
  expect(detectClient(undefined)).toBe('')
})

test('detectClient: unknown UA falls back to first product token', () => {
  expect(detectClient('MyApp/1.0 (linux)')).toBe('myapp')
  expect(detectClient('Foo-Bar.Baz/9 (etc)')).toBe('foo-bar.baz')
})

test('detectClient: claude-code Claude/ form', () => {
  expect(detectClient('Claude/1.0 (Anthropic)')).toBe('claude-code')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd vnext/apps/gateway && bun test tests/observability/client-detect.test.ts`
Expected: FAIL with module-not-found error for `client-detect.ts`.

---

### Task 3: `client-detect.ts` — implement

**Files:**
- Create: `vnext/apps/gateway/src/shared/observability/client-detect.ts`

- [ ] **Step 1: Write the implementation (port of `src/lib/client-detect.ts`)**

```ts
/**
 * Detect client software from User-Agent header.
 *
 * Returns a short, stable identifier like "claude-code", "cursor", "vscode",
 * etc. Unknown clients fall back to the first UA product token (e.g.
 * "python-requests"). Empty / null UA returns "".
 */

interface ClientPattern {
  pattern: RegExp
  name: string
}

const CLIENT_PATTERNS: ClientPattern[] = [
  { pattern: /claude-code/i, name: 'claude-code' },
  { pattern: /Claude\//i, name: 'claude-code' },
  { pattern: /codex-cli/i, name: 'codex-cli' },
  { pattern: /Codex\//i, name: 'codex-cli' },
  { pattern: /gemini-cli/i, name: 'gemini-cli' },
  { pattern: /cursor/i, name: 'cursor' },
  { pattern: /Windsurf/i, name: 'windsurf' },
  { pattern: /Cline/i, name: 'cline' },
  { pattern: /Continue/i, name: 'continue' },
  { pattern: /Aider/i, name: 'aider' },
  { pattern: /Copilot/i, name: 'copilot' },
  { pattern: /openclaw/i, name: 'openclaw' },
  { pattern: /antigravity/i, name: 'antigravity' },
  { pattern: /JetBrains/i, name: 'jetbrains' },
  { pattern: /VSCode/i, name: 'vscode' },
  { pattern: /Visual Studio Code/i, name: 'vscode' },
  { pattern: /Neovim/i, name: 'neovim' },
  { pattern: /Vim/i, name: 'vim' },
  { pattern: /anthropic-typescript/i, name: 'anthropic-sdk-ts' },
  { pattern: /anthropic-python/i, name: 'anthropic-sdk-py' },
  { pattern: /Anthropic/i, name: 'anthropic-sdk' },
  { pattern: /openai-node/i, name: 'openai-sdk-ts' },
  { pattern: /openai-python/i, name: 'openai-sdk-py' },
  { pattern: /OpenAI\//i, name: 'openai-sdk' },
  { pattern: /python-requests/i, name: 'python-requests' },
  { pattern: /python-httpx/i, name: 'python-httpx' },
  { pattern: /node-fetch/i, name: 'node-fetch' },
  { pattern: /axios/i, name: 'axios' },
  { pattern: /curl/i, name: 'curl' },
  { pattern: /Wget/i, name: 'wget' },
]

export function detectClient(userAgent: string | null | undefined): string {
  if (!userAgent) return ''
  for (const { pattern, name } of CLIENT_PATTERNS) {
    if (pattern.test(userAgent)) return name
  }
  const firstToken = userAgent.match(/^([A-Za-z][\w.-]*)/)
  if (firstToken && firstToken[1]) return firstToken[1].toLowerCase()
  return ''
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd vnext/apps/gateway && bun test tests/observability/client-detect.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 3: Commit**

```bash
git add vnext/apps/gateway/src/shared/observability/client-detect.ts vnext/apps/gateway/tests/observability/client-detect.test.ts
git commit -m "feat(gateway/obs): port client-detect with golden-UA tests"
```

---

### Task 4: `quota-math.ts` — write the failing test

**Files:**
- Test: `vnext/apps/gateway/tests/observability/quota-math.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from 'bun:test'
import { computeWeightedTokens } from '../../src/shared/observability/quota-math.ts'

test('computeWeightedTokens: formula = cache*0.1 + input*1 + output*5', () => {
  expect(computeWeightedTokens(0, 0, 0)).toBe(0)
  expect(computeWeightedTokens(100, 0, 0)).toBeCloseTo(10)
  expect(computeWeightedTokens(0, 100, 0)).toBeCloseTo(100)
  expect(computeWeightedTokens(0, 0, 100)).toBeCloseTo(500)
  expect(computeWeightedTokens(100, 200, 50)).toBeCloseTo(10 + 200 + 250)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd vnext/apps/gateway && bun test tests/observability/quota-math.test.ts`
Expected: FAIL with module-not-found.

---

### Task 5: `quota-math.ts` — implement

**Files:**
- Create: `vnext/apps/gateway/src/shared/observability/quota-math.ts`

- [ ] **Step 1: Write the implementation**

```ts
/**
 * Weighted-token formula used by the daily quota gate:
 *   cacheRead × 0.1 + input × 1.0 + output × 5.0
 *
 * Lives in its own file so the pure formula can be unit-tested without
 * pulling in `getRepo()`. `quota.ts` (Phase 2) re-exports this symbol.
 */
export function computeWeightedTokens(
  cacheReadTokens: number,
  inputTokens: number,
  outputTokens: number,
): number {
  return cacheReadTokens * 0.1 + inputTokens * 1.0 + outputTokens * 5.0
}
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd vnext/apps/gateway && bun test tests/observability/quota-math.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add vnext/apps/gateway/src/shared/observability/quota-math.ts vnext/apps/gateway/tests/observability/quota-math.test.ts
git commit -m "feat(gateway/obs): pure computeWeightedTokens helper"
```

---

### Task 6: `usage-extractor.ts` — write the failing test (JSON paths)

**Files:**
- Test: `vnext/apps/gateway/tests/observability/usage-extractor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from 'bun:test'
import {
  extractFromJson,
  applyStreamEvent,
  pickUsageModelId,
  type UsageInfo,
} from '../../src/shared/observability/usage-extractor.ts'

test('extractFromJson: Anthropic Messages with cache fields', () => {
  const out = extractFromJson({
    model: 'claude-opus-4-7',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 30,
    },
  })
  expect(out).toEqual({
    model: 'claude-opus-4.7',
    input: 100, output: 50, cacheRead: 200, cacheCreation: 30,
  })
})

test('extractFromJson: Responses input_tokens_details.cached_tokens subtraction', () => {
  const out = extractFromJson({
    response: { model: 'gpt-5' },
    usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 30 } },
  })
  expect(out).toEqual({
    model: 'gpt-5',
    input: 70, output: 20, cacheRead: 30, cacheCreation: 0,
  })
})

test('extractFromJson: OpenAI Chat prompt_tokens', () => {
  const out = extractFromJson({
    model: 'gpt-4o',
    usage: { prompt_tokens: 100, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 10 } },
  })
  expect(out).toEqual({
    model: 'gpt-4o',
    input: 90, output: 25, cacheRead: 10, cacheCreation: 0,
  })
})

test('extractFromJson: returns null when no usage block', () => {
  expect(extractFromJson({ model: 'gpt-4o' })).toBeNull()
  expect(extractFromJson({})).toBeNull()
  expect(extractFromJson(null)).toBeNull()
})

test('pickUsageModelId: caller variant beats less-specific JSON sibling', () => {
  // Anthropic Messages strips -internal — caller is more specific
  expect(pickUsageModelId('claude-opus-4.7', 'claude-opus-4-7-1m-internal'))
    .toBe('claude-opus-4.7-1m-internal')
})

test('pickUsageModelId: caller dash → dot normalization', () => {
  expect(pickUsageModelId(undefined, 'claude-opus-4-7'))
    .toBe('claude-opus-4.7')
})

test('pickUsageModelId: JSON wins for unrelated ids', () => {
  expect(pickUsageModelId('gpt-5.5', 'claude-code-sdk')).toBe('gpt-5.5')
})

test('applyStreamEvent: Anthropic message_start sets input/cache, not terminal', () => {
  const latest: UsageInfo = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  const terminal = applyStreamEvent({
    type: 'message_start',
    message: { model: 'claude-opus-4-7', usage: { input_tokens: 50, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 } },
  }, latest)
  expect(terminal).toBe(false)
  expect(latest.input).toBe(50)
  expect(latest.cacheRead).toBe(5)
  expect(latest.cacheCreation).toBe(1)
  expect(latest.model).toBe('claude-opus-4.7')
})

test('applyStreamEvent: Anthropic message_delta accumulates, not terminal', () => {
  const latest: UsageInfo = { input: 50, output: 0, cacheRead: 0, cacheCreation: 0 }
  const terminal = applyStreamEvent({ type: 'message_delta', usage: { output_tokens: 25 } }, latest)
  expect(terminal).toBe(false)
  expect(latest.output).toBe(25)
})

test('applyStreamEvent: Responses response.completed is terminal', () => {
  const latest: UsageInfo = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  const terminal = applyStreamEvent({
    type: 'response.completed',
    response: { usage: { input_tokens: 100, output_tokens: 30, input_tokens_details: { cached_tokens: 20 } } },
  }, latest)
  expect(terminal).toBe(true)
  expect(latest.input).toBe(80)
  expect(latest.output).toBe(30)
  expect(latest.cacheRead).toBe(20)
})

test('applyStreamEvent: OpenAI Chat end-frame is terminal', () => {
  const latest: UsageInfo = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  const terminal = applyStreamEvent({
    usage: { prompt_tokens: 50, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 5 } },
  }, latest)
  expect(terminal).toBe(true)
  expect(latest.input).toBe(45)
  expect(latest.output).toBe(10)
  expect(latest.cacheRead).toBe(5)
})

test('applyStreamEvent: unrelated event returns false, no mutation', () => {
  const latest: UsageInfo = { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 }
  expect(applyStreamEvent({ type: 'content_block_start' }, latest)).toBe(false)
  expect(latest).toEqual({ input: 1, output: 2, cacheRead: 3, cacheCreation: 4 })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd vnext/apps/gateway && bun test tests/observability/usage-extractor.test.ts`
Expected: FAIL with module-not-found.

---

### Task 7: `usage-extractor.ts` — implement

**Files:**
- Create: `vnext/apps/gateway/src/shared/observability/usage-extractor.ts`

- [ ] **Step 1: Write the implementation (port of `src/middleware/usage.ts:28-143`)**

```ts
/**
 * Pure usage parsers for JSON bodies and SSE event frames.
 *
 * Three response shapes are recognized:
 *   1. Anthropic Messages — gated on `cache_read_input_tokens` /
 *      `cache_creation_input_tokens` to disambiguate from Responses.
 *   2. /v1/responses — input_tokens + input_tokens_details.cached_tokens.
 *   3. OpenAI Chat Completions — prompt_tokens + prompt_tokens_details.cached_tokens.
 *
 * Stream events are folded into a `latest` accumulator; only Responses
 * `response.completed` / `response.incomplete` and OpenAI Chat end-frames
 * are terminal (returning `true`). Anthropic `message_start` and
 * `message_delta` are NOT terminal — more deltas can still follow.
 */
import { copilotPublicModelId, normalizeAnthropicVersion } from '@vnext/provider-copilot'

export interface UsageInfo {
  model?: string
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

function normalizeUsageModelId(id: string | undefined): string | undefined {
  if (!id) return id
  return normalizeAnthropicVersion(id)
}

function modelFromJson(json: unknown): string | undefined {
  const j = json as { model?: unknown; message?: { model?: unknown }; response?: { model?: unknown } } | null
  const candidate = j?.model ?? j?.message?.model ?? j?.response?.model
  const raw = typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
  return normalizeUsageModelId(raw)
}

/**
 * Pick the most specific id between caller-provided and JSON-extracted.
 * Caller wins only when (a) both refer to the same Copilot logical model,
 * and (b) caller carries a strictly longer variant suffix.
 */
export function pickUsageModelId(
  fromJson: string | undefined,
  fromCaller: string,
): string {
  const normalizedCaller = normalizeUsageModelId(fromCaller)
  if (!fromJson) return normalizedCaller ?? fromCaller
  if (!normalizedCaller) return fromJson
  if (normalizedCaller === fromJson) return fromJson
  const sameBase = copilotPublicModelId(normalizedCaller) === copilotPublicModelId(fromJson)
  if (sameBase && normalizedCaller.length > fromJson.length) return normalizedCaller
  return fromJson
}

export function extractFromJson(json: unknown): UsageInfo | null {
  const j = json as {
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      input_tokens_details?: { cached_tokens?: number }
      prompt_tokens?: number
      completion_tokens?: number
      prompt_tokens_details?: { cached_tokens?: number }
    }
  } | null
  const u = j?.usage
  if (!u) return null

  if (u.input_tokens != null && (u.cache_read_input_tokens !== undefined || u.cache_creation_input_tokens !== undefined)) {
    return {
      model: modelFromJson(json),
      input: u.input_tokens,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheCreation: u.cache_creation_input_tokens ?? 0,
    }
  }
  if (u.input_tokens != null) {
    const cached = u.input_tokens_details?.cached_tokens ?? 0
    return {
      model: modelFromJson(json),
      input: Math.max(0, u.input_tokens - cached),
      output: u.output_tokens ?? 0,
      cacheRead: cached,
      cacheCreation: 0,
    }
  }
  if (u.prompt_tokens != null) {
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0
    return {
      model: modelFromJson(json),
      input: Math.max(0, u.prompt_tokens - cached),
      output: u.completion_tokens ?? 0,
      cacheRead: cached,
      cacheCreation: 0,
    }
  }
  return null
}

/**
 * Fold an SSE event into the running usage accumulator.
 * Returns `true` on terminal frames (Responses completed/incomplete,
 * OpenAI Chat end-frame). Anthropic message_start / message_delta are
 * cumulative and NOT terminal.
 */
export function applyStreamEvent(parsed: unknown, latest: UsageInfo): boolean {
  const p = parsed as {
    type?: string
    message?: { model?: string; usage?: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
    response?: { model?: string; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } }
    usage?: { output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
    model?: string
  }

  const eventModel = modelFromJson(parsed)
  if (eventModel) latest.model = eventModel

  if (p.type === 'message_start' && p.message?.usage?.input_tokens != null) {
    const u = p.message.usage
    latest.input = u.input_tokens
    if (u.cache_read_input_tokens != null) latest.cacheRead = u.cache_read_input_tokens
    if (u.cache_creation_input_tokens != null) latest.cacheCreation = u.cache_creation_input_tokens
    return false
  }
  if (p.type === 'message_delta' && p.usage?.output_tokens != null) {
    const u = p.usage
    latest.output = u.output_tokens
    if (u.cache_read_input_tokens != null) latest.cacheRead = u.cache_read_input_tokens
    if (u.cache_creation_input_tokens != null) latest.cacheCreation = u.cache_creation_input_tokens
    return false
  }
  if ((p.type === 'response.completed' || p.type === 'response.incomplete') && p.response?.usage) {
    const u = p.response.usage
    const cached = u.input_tokens_details?.cached_tokens ?? 0
    latest.input = Math.max(0, (u.input_tokens ?? 0) - cached)
    latest.output = u.output_tokens ?? 0
    latest.cacheRead = cached
    latest.cacheCreation = 0
    return true
  }
  if (p.usage?.prompt_tokens != null) {
    const cached = p.usage.prompt_tokens_details?.cached_tokens ?? 0
    latest.input = Math.max(0, p.usage.prompt_tokens - cached)
    latest.output = p.usage.completion_tokens ?? 0
    latest.cacheRead = cached
    latest.cacheCreation = 0
    return true
  }
  return false
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd vnext/apps/gateway && bun test tests/observability/usage-extractor.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 3: Typecheck the gateway**

Run: `cd vnext && bun run -F '@vnext/gateway' typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add vnext/apps/gateway/src/shared/observability/usage-extractor.ts vnext/apps/gateway/tests/observability/usage-extractor.test.ts
git commit -m "feat(gateway/obs): pure usage extractor (JSON + SSE) with 12 tests"
```

---

### Task 8: Phase 1 acceptance — full suite green

- [ ] **Step 1: Run the entire gateway test suite**

Run: `cd vnext/apps/gateway && bun test`
Expected: full suite green, including the 3 new test files (4 + 5 + 12 = 21 added cases).

- [ ] **Step 2: Workspace typecheck**

Run: `cd vnext && bun run -F '@vnext/provider-copilot' typecheck && bun run -F '@vnext/gateway' typecheck`
Expected: both exit 0.

If anything fails, fix before declaring Phase 1 complete. No stub commits.

---

## Phase 1 done — what to do next

Move on to `2026-06-11-observability-phase2-stateful.md` which adds:
- `ApiKeyRepo.touchLastUsed` contract + sqlite/d1 implementations + tests
- `quota.ts` (`checkQuota` calling `getRepo()`) + tests
- `latency-tracker.ts` (`recordLatency` writing to repo + perf fan-out) + tests
- `usage-tracker.ts` (3 entrypoints calling `getRepo`) + tests

Phase 1 alone produces no observable behavior change at runtime — it only adds new files. That is intentional: the wiring lives in Phase 3.
