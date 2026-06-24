# Spec 7 Part 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the new `@vnext/service` framework package, evict LLM-specific aliases to `@vnext/protocols/common`, and turn `@vnext/interceptor` into a thin compat re-export layer — without touching any consumer file. After Part 1, all 53 consumer files still import from `@vnext/interceptor` and the whole monorepo typechecks + tests pass.

**Architecture:** Add a new domain-neutral package `@vnext/service` exposing `Interceptor<Ctx, Req, Result>` (Charter §4.1 generic order) + `Service<Ctx, Req, Result>` placeholder interface + `runInterceptors`. Move LLM-specific type aliases (`Invocation`, `RequestContext`, `CopilotInterceptor`, 3 stream interceptor aliases) into `@vnext/protocols/common` (Spec 8 will relocate them again to `protocols-llm`). Rewrite `@vnext/interceptor/src/index.ts` as pure re-export so existing consumers keep compiling.

**Tech Stack:** Bun workspace, TypeScript strict mode, `bun:test`.

**Spec reference:** [`vnext/docs/superpowers/specs/2026-06-24-spec7-service-package.md`](../specs/2026-06-24-spec7-service-package.md) §3-6, §10.1

**Worktree:** Use `superpowers:using-git-worktrees` to create an isolated worktree before starting (branch e.g. `spec7-part1-foundation`).

---

## Task 1: Create `@vnext/service` package skeleton

**Files:**
- Create: `vnext/packages/service/package.json`
- Create: `vnext/packages/service/tsconfig.json`
- Create: `vnext/packages/service/src/index.ts`
- Create: `vnext/packages/service/src/__tests__/run-interceptors.test.ts`

- [ ] **Step 1: Write the failing test** — `vnext/packages/service/src/__tests__/run-interceptors.test.ts`

```ts
import { test, expect } from 'bun:test'
import { runInterceptors, type Interceptor } from '../index'

interface Ctx { tag: string }
interface Req { value: number }
type Result = string

test('runInterceptors invokes terminal when no interceptors', async () => {
  const out = await runInterceptors<Ctx, Req, Result>(
    { value: 1 },
    { tag: 't' },
    [],
    async () => 'terminal',
  )
  expect(out).toBe('terminal')
})

test('runInterceptors composes interceptors in order, terminal last', async () => {
  const trace: string[] = []
  const a: Interceptor<Ctx, Req, Result> = async (req, ctx, next) => {
    trace.push(`a-before:${ctx.tag}:${req.value}`)
    const r = await next()
    trace.push('a-after')
    return `[a]${r}`
  }
  const b: Interceptor<Ctx, Req, Result> = async (_req, _ctx, next) => {
    trace.push('b-before')
    const r = await next()
    trace.push('b-after')
    return `[b]${r}`
  }
  const out = await runInterceptors<Ctx, Req, Result>(
    { value: 7 },
    { tag: 'T' },
    [a, b],
    async () => {
      trace.push('terminal')
      return 'X'
    },
  )
  expect(out).toBe('[a][b]X')
  expect(trace).toEqual([
    'a-before:T:7',
    'b-before',
    'terminal',
    'b-after',
    'a-after',
  ])
})

test('interceptor can short-circuit without calling next', async () => {
  let terminalCalled = false
  const shortCircuit: Interceptor<Ctx, Req, Result> = async () => 'SHORT'
  const out = await runInterceptors<Ctx, Req, Result>(
    { value: 0 },
    { tag: 'x' },
    [shortCircuit],
    async () => {
      terminalCalled = true
      return 'NEVER'
    },
  )
  expect(out).toBe('SHORT')
  expect(terminalCalled).toBe(false)
})
```

- [ ] **Step 2: Write `package.json`** — `vnext/packages/service/package.json`

```json
{
  "name": "@vnext/service",
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

Note: no `dependencies`. If TS or other dev tooling is needed it must go in `devDependencies` and prefer reusing the vnext root devDependencies.

- [ ] **Step 3: Write `tsconfig.json`** — `vnext/packages/service/tsconfig.json`

Copy the structure used in a peer framework package — read `vnext/packages/interceptor/tsconfig.json` and replicate (likely extends a root `tsconfig.base.json`). Adjust paths so it resolves relative to `vnext/packages/service/`.

- [ ] **Step 4: Write `src/index.ts`** — exactly the surface from spec §4

```ts
/**
 * Domain-neutral around-middleware.
 * Charter §4.1 Contract A (with Spec 7 deviation noted below).
 *
 * NOTE on `next` arity: Charter §4.1 ideal form is `next: (req: Req) => Promise<Result>`,
 * propagating a fresh req down the chain. Current code uses `next: () => Promise<Result>`
 * and mutates shared invocation state. Spec 7 keeps zero-behavior-change: `next` stays
 * `() => Promise<Result>`. Migrating to req-propagation is a separate future spec
 * (breaks all existing interceptor implementations; requires Invocation immutability).
 */
export type Interceptor<Ctx, Req, Result> = (
  req: Req,
  ctx: Ctx,
  next: () => Promise<Result>,
) => Promise<Result>

/**
 * Service interface placeholder. Real terminal-handler wrapping
 * deferred to Spec 10 (chat-flow Codec convergence).
 */
export interface Service<Ctx, Req, Result> {
  invoke(req: Req, ctx: Ctx): Promise<Result>
}

export type Next<R> = () => Promise<R>

/**
 * Compose an interceptor chain with a terminal handler and run it.
 * Behaviorally identical to the legacy @vnext/interceptor.runInterceptors;
 * only the generic parameter order changes to <Ctx, Req, R>.
 */
export const runInterceptors = async <Ctx, Req, R>(
  req: Req,
  ctx: Ctx,
  interceptors: readonly Interceptor<Ctx, Req, R>[],
  terminal: Next<R>,
): Promise<R> => {
  const run = (index: number): Promise<R> =>
    index < interceptors.length
      ? interceptors[index]!(req, ctx, () => run(index + 1))
      : terminal()
  return run(0)
}
```

- [ ] **Step 5: Register in workspace** — verify `vnext/package.json` `workspaces` field uses `packages/*` glob (it does, per spec). If not glob, add `"packages/service"`. Then run `cd vnext && bun install` to materialize the new package.

- [ ] **Step 6: Run tests** — `cd vnext && bun test packages/service`

Expected: 3 tests pass.

- [ ] **Step 7: Run independent typecheck** — `cd vnext/packages/service && bun run typecheck`

Expected: no errors.

- [ ] **Step 8: Smoke check — no @vnext/* runtime deps** — `rg '@vnext/' vnext/packages/service/package.json`

Expected: empty (Spec §3 invariant + §8.1).

- [ ] **Step 9: Smoke check — no @vnext/protocols anywhere in service pkg** — `rg '@vnext/protocols' vnext/packages/service`

Expected: empty.

- [ ] **Step 10: Commit**

```bash
git add vnext/packages/service vnext/package.json vnext/bun.lock 2>/dev/null
git commit -m "feat(vnext/service): scaffold @vnext/service framework package

New domain-neutral package per Charter §4.1 Contract A. Exports
Interceptor<Ctx,Req,Result>, Service<Ctx,Req,Result> placeholder,
and runInterceptors. No runtime deps on any @vnext/* package."
```

---

## Task 2: Move LLM aliases into `@vnext/protocols/common`

**Files:**
- Create: `vnext/packages/protocols/src/common/invocation.ts`
- Modify: `vnext/packages/protocols/src/common/index.ts`
- Modify: `vnext/packages/protocols/package.json` (add `@vnext/service` dep)
- Create: `vnext/packages/protocols/src/common/__tests__/invocation.test.ts`

- [ ] **Step 1: Write the failing test** — `vnext/packages/protocols/src/common/__tests__/invocation.test.ts`

```ts
import { test, expect } from 'bun:test'
import type {
  Invocation,
  RequestContext,
  CopilotInterceptor,
  ChatCompletionsStreamInterceptor,
  MessagesStreamInterceptor,
  ResponsesStreamInterceptor,
} from '../invocation'

test('Invocation has expected mutable + readonly shape', () => {
  const inv: Invocation = {
    endpoint: 'chat-completions' as Invocation['endpoint'],
    enabledFlags: new Set<string>(),
    payload: {},
    headers: {},
  }
  // mutability check (compile-time more than runtime; this asserts surface)
  inv.payload = { a: 1 }
  inv.headers = { 'x-trace': 'abc' }
  expect(inv.endpoint).toBeTruthy()
  expect(inv.enabledFlags.size).toBe(0)
})

test('CopilotInterceptor signature is (req, ctx, next) => Promise<Response>', async () => {
  const fn: CopilotInterceptor = async (_req, _ctx, next) => next()
  const ctx: RequestContext = { requestStartedAt: Date.now() }
  const inv: Invocation = {
    endpoint: 'chat-completions' as Invocation['endpoint'],
    enabledFlags: new Set<string>(),
    payload: {},
    headers: {},
  }
  const out = await fn(inv, ctx, async () => new Response('ok'))
  expect(await out.text()).toBe('ok')
})

test('stream interceptor aliases compile (type-level smoke)', () => {
  // If these compile, the test passes. Runtime is a no-op.
  const _cc: ChatCompletionsStreamInterceptor | undefined = undefined
  const _msg: MessagesStreamInterceptor | undefined = undefined
  const _rsp: ResponsesStreamInterceptor | undefined = undefined
  expect(_cc).toBeUndefined()
  expect(_msg).toBeUndefined()
  expect(_rsp).toBeUndefined()
})
```

- [ ] **Step 2: Add `@vnext/service` to protocols deps** — `vnext/packages/protocols/package.json`

Add to `dependencies`:

```json
"@vnext/service": "workspace:*"
```

Result:

```json
"dependencies": {
  "@vnext/service": "workspace:*",
  "zod": "^4.4.3"
}
```

Run `cd vnext && bun install`.

- [ ] **Step 3: Create `invocation.ts`** — `vnext/packages/protocols/src/common/invocation.ts`

```ts
import type { EndpointKey } from './index'
import type { ExecuteResult } from './result'
import type { ProtocolFrame } from './sse'
import type { ChatCompletionsStreamEvent } from '../chat'
import type { MessagesStreamEvent } from '../messages'
import type { ResponsesStreamEvent } from '../responses'
import type { Interceptor } from '@vnext/service'

export interface Invocation {
  readonly endpoint: EndpointKey
  readonly enabledFlags: ReadonlySet<string>
  readonly sourceApi?: 'messages' | 'chat_completions' | 'responses' | 'gemini'
  payload: Record<string, unknown>
  headers: Record<string, string>
}

export interface RequestContext {
  readonly requestStartedAt: number
  readonly downstreamAbortSignal?: AbortSignal
}

export type CopilotInterceptor = Interceptor<RequestContext, Invocation, Response>

export type ChatCompletionsStreamInterceptor = Interceptor<
  RequestContext,
  Invocation,
  ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>
>

export type MessagesStreamInterceptor = Interceptor<
  RequestContext,
  Invocation,
  ExecuteResult<ProtocolFrame<MessagesStreamEvent>>
>

export type ResponsesStreamInterceptor = Interceptor<
  RequestContext,
  Invocation,
  ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
>
```

Note: import paths verified against `vnext/packages/protocols/src/common/` actual layout — `EndpointKey` lives in `./index`, `ProtocolFrame` in `./sse`, `ExecuteResult` in `./result`.

If any of those exports are missing (verify with `rg 'export.*EndpointKey' vnext/packages/protocols/src/common` etc.), pause and report — the spec assumes they exist.

- [ ] **Step 4: Re-export from common barrel** — modify `vnext/packages/protocols/src/common/index.ts`

Add line at the end:

```ts
export * from './invocation'
```

Verify no name collision: `rg '^export.*\b(Invocation|RequestContext|CopilotInterceptor|ChatCompletionsStreamInterceptor|MessagesStreamInterceptor|ResponsesStreamInterceptor)\b' vnext/packages/protocols/src/common/` — should only show invocation.ts after this change.

- [ ] **Step 5: Run protocols typecheck** — `cd vnext/packages/protocols && bun run typecheck`

Expected: no errors.

- [ ] **Step 6: Run new test** — `cd vnext && bun test packages/protocols/src/common/__tests__/invocation.test.ts`

Expected: 3 tests pass.

- [ ] **Step 7: Run full vnext suite** — `cd vnext && bun test`

Expected: same pass/fail count as baseline (no regression). Note baseline pre-Spec 7 in the commit message.

- [ ] **Step 8: Commit**

```bash
git add vnext/packages/protocols vnext/bun.lock
git commit -m "feat(vnext/protocols/common): host Invocation + LLM interceptor aliases

Adds Invocation, RequestContext, CopilotInterceptor, and 3 stream
interceptor aliases parametrized over @vnext/service's generic
Interceptor<Ctx,Req,Result>. Temporary home — Spec 8 will move
them to @vnext/protocols-llm."
```

---

## Task 3: Rewrite `@vnext/interceptor` as compat re-export layer

**Files:**
- Modify: `vnext/packages/interceptor/src/index.ts` (replace with pure re-exports)
- Modify: `vnext/packages/interceptor/package.json` (add `@vnext/service` dep, keep `@vnext/protocols`)

- [ ] **Step 1: Update interceptor package.json** — add `@vnext/service`, keep `@vnext/protocols`

```json
"dependencies": {
  "@vnext/protocols": "workspace:*",
  "@vnext/service": "workspace:*"
}
```

Run `cd vnext && bun install`.

- [ ] **Step 2: Replace `src/index.ts` with re-exports** — `vnext/packages/interceptor/src/index.ts`

```ts
/**
 * Compatibility shim. Real definitions live in:
 *   - @vnext/service             (Interceptor, Service, runInterceptors, Next)
 *   - @vnext/protocols/common    (Invocation, RequestContext, CopilotInterceptor,
 *                                 ChatCompletions/Messages/Responses StreamInterceptor)
 *
 * Slated for removal in Spec 7 Part 3 (T7). Do not add new code here —
 * import directly from @vnext/service or @vnext/protocols/common in new files.
 */
export {
  runInterceptors,
  type Interceptor,
  type Service,
  type Next,
} from '@vnext/service'

// Legacy alias name (Service's runner used to be typed via this);
// keep until Part 2 migrates the last consumer.
export type { Next as InterceptorRun } from '@vnext/service'

export type {
  Invocation,
  RequestContext,
  CopilotInterceptor,
  ChatCompletionsStreamInterceptor,
  MessagesStreamInterceptor,
  ResponsesStreamInterceptor,
} from '@vnext/protocols/common'
```

**Why `InterceptorRun` alias:** the original `interceptor/src/index.ts` exported `InterceptorRun<R>`. Re-export it as an alias of `Next<R>` from `@vnext/service` so consumers that imported `InterceptorRun` still compile during Part 2 migration. Part 2 will delete remaining `InterceptorRun` imports along with the rest.

- [ ] **Step 3: Verify legacy generic order still works** — the **old** `Interceptor<TInv, TCtx, R>` was `<Inv, Ctx, R>` (params: inv, ctx, run). The **new** generic from `@vnext/service` is `<Ctx, Req, R>` (params: req, ctx, next).

**Generic order changed.** Any consumer that wrote `Interceptor<Invocation, RequestContext, Response>` directly (positional generics) will now typecheck against `<Ctx=Invocation, Req=RequestContext, Result=Response>` — semantically wrong but possibly still compiles. Mitigation: in this Part 1 we do NOT migrate consumers; we expect typecheck to pass because consumers overwhelmingly use **named type aliases** (`CopilotInterceptor`, etc.). The named aliases are re-exported with the correct new generic argument order, so they keep working transparently.

Run full grep to confirm: `rg 'Interceptor<' vnext/packages vnext/apps -t ts -t tsx | rg -v 'CopilotInterceptor|ChatCompletionsStreamInterceptor|MessagesStreamInterceptor|ResponsesStreamInterceptor|@vnext/service|@vnext/protocols'`

If hits exist, list them in commit notes — Part 2 §6.2 covers their migration.

- [ ] **Step 4: Run interceptor typecheck** — `cd vnext/packages/interceptor && bun run typecheck`

Expected: no errors.

- [ ] **Step 5: Run all dependent packages' typecheck**

```bash
cd vnext/packages/protocols && bun run typecheck
cd vnext/packages/gateway && bun run typecheck
cd vnext/packages/provider-copilot && bun run typecheck
```

Expected: each independently passes. If any fails, the compat layer is missing an export — extend it (don't migrate consumers in this Part).

- [ ] **Step 6: Run full vnext test suite** — `cd vnext && bun test`

Expected: zero regressions vs baseline.

- [ ] **Step 7: Smoke check — no consumer touched** — `git diff --stat HEAD~2 -- vnext/packages | rg -v 'service|protocols|interceptor/package.json|interceptor/src/index.ts'`

Expected: empty (no consumer files modified by Part 1).

- [ ] **Step 8: Commit**

```bash
git add vnext/packages/interceptor vnext/bun.lock
git commit -m "refactor(vnext/interceptor): convert to compat re-export shim

Re-exports Interceptor/Service/runInterceptors from @vnext/service
and Invocation/RequestContext/4 LLM aliases from @vnext/protocols/common.
Existing 53 consumer files keep their import path through Part 2.
Slated for deletion in Spec 7 Part 3 (T7)."
```

---

## Acceptance for Part 1

- [ ] `vnext/packages/service/` exists with `package.json`, `tsconfig.json`, `src/index.ts`, 3 passing unit tests
- [ ] `vnext/packages/service/package.json` `dependencies` is absent or empty (no `@vnext/*`)
- [ ] `rg '@vnext/protocols' vnext/packages/service` returns empty
- [ ] `vnext/packages/protocols/src/common/invocation.ts` exists with 4 LLM aliases parametrized over `@vnext/service`'s `Interceptor`
- [ ] `vnext/packages/interceptor/src/index.ts` is pure re-exports (no original type/function definitions)
- [ ] `cd vnext/packages/service && bun run typecheck` passes
- [ ] `cd vnext/packages/protocols && bun run typecheck` passes
- [ ] `cd vnext/packages/interceptor && bun run typecheck` passes
- [ ] `cd vnext/packages/gateway && bun run typecheck` passes
- [ ] `cd vnext/packages/provider-copilot && bun run typecheck` passes
- [ ] `cd vnext && bun test` — zero regressions vs baseline (record baseline test count in PR/commit body)
- [ ] No consumer file in `vnext/packages/{gateway,provider-copilot}/src` or tests has been modified

---

## Rollback

Each of T1/T2/T3 commits is independent and reversible. If Part 1 needs to abort:

```bash
git revert <T3-sha> <T2-sha> <T1-sha>
cd vnext && bun install   # rebuild lockfile against reverted state
cd vnext && bun test       # verify back to baseline
```

System state after rollback identical to pre-Part-1 baseline.
