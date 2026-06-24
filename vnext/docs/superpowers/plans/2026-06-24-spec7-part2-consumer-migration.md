# Spec 7 Part 2 — Consumer Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate every consumer of `@vnext/interceptor` to import directly from `@vnext/service` and `@vnext/protocols/common`. After Part 2, no `*.ts` file in `vnext/packages` or `vnext/apps` imports `@vnext/interceptor` (only its own re-export shim still mentions itself).

**Architecture:** Spec 7 §6.1 import substitution applied in batches by owning package. Each batch is an independent commit; between batches, the compat shim from Part 1 keeps unmigrated files working. Test suite must stay green after every commit.

**Tech Stack:** Bun workspace, TypeScript, `bun:test`.

**Spec reference:** [`vnext/docs/superpowers/specs/2026-06-24-spec7-service-package.md`](../specs/2026-06-24-spec7-service-package.md) §6, §10.1, §10.3

**Prerequisite:** Part 1 (`@vnext/service` exists, compat shim in place) merged.

**Worktree:** Continue in the Part 1 worktree, or create a fresh `spec7-part2-consumer-migration` worktree off the post-Part-1 commit.

---

## Migration Recipe (apply per file)

For each consumer `.ts`:

1. Find the existing `import { ... } from '@vnext/interceptor'` line.
2. Partition the named imports:
   - **From `@vnext/service`:** `runInterceptors`, `Interceptor`, `Service`, `Next`, `InterceptorRun` (legacy alias)
   - **From `@vnext/protocols/common`:** `Invocation`, `RequestContext`, `CopilotInterceptor`, `ChatCompletionsStreamInterceptor`, `MessagesStreamInterceptor`, `ResponsesStreamInterceptor`
3. Replace the single import with the appropriate split (omit either side if no names belong there).
4. If the file uses `Interceptor<X, Y, Z>` **positional generics** (not via type alias), swap arg order from old `<Inv, Ctx, R>` to new `<Ctx, Req, R>`. Per Part 1 §Step 3 verification — `rg 'Interceptor<' vnext/packages vnext/apps -t ts | rg -v 'CopilotInterceptor|ChatCompletionsStreamInterceptor|MessagesStreamInterceptor|ResponsesStreamInterceptor|@vnext/'` — Part 1 should have produced an explicit list. If list was empty, this step is a no-op.
5. If the file uses `InterceptorRun<R>` — replace with `Next<R>` (semantically identical, name change recommended for clarity).

Use `type` import keyword for type-only names (TS strict imports policy in vnext).

### Example diff

```diff
- import { CopilotInterceptor, runInterceptors, type Invocation, type RequestContext, type InterceptorRun } from '@vnext/interceptor'
+ import { runInterceptors, type Next } from '@vnext/service'
+ import type { CopilotInterceptor, Invocation, RequestContext } from '@vnext/protocols/common'
```

(Then rename `InterceptorRun<R>` → `Next<R>` usages in the file body.)

---

## Task 1: Migrate `gateway/src/data-plane/chat-flow/**`

**Scope (8 files, verified via `rg '@vnext/interceptor' vnext/packages/gateway/src -l`):**
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/types.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/messages/attempt.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/messages/interceptors/types.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/types.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/gemini/attempt.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/shared/telemetry-ctx.ts`

- [ ] **Step 1: Re-grep for current ground-truth** — `rg '@vnext/interceptor' vnext/packages/gateway/src -l`

Confirm the 8 files listed above. If list differs, use the live list — migrate every file shown.

- [ ] **Step 2: Update `gateway/package.json`**

Add to `dependencies`:

```json
"@vnext/service": "workspace:*"
```

Remove from `dependencies`:

```
"@vnext/interceptor": "workspace:*"
```

Run `cd vnext && bun install`.

- [ ] **Step 3: Apply migration recipe** to each of the 8 files

For each file: read it, identify the `@vnext/interceptor` import, apply the partition recipe above. Do not add or change any other code in the file (no unrelated refactors).

- [ ] **Step 4: Verify gateway src no longer references interceptor pkg** — `rg '@vnext/interceptor' vnext/packages/gateway/src`

Expected: empty.

- [ ] **Step 5: Typecheck gateway** — `cd vnext/packages/gateway && bun run typecheck`

Expected: no errors. If errors complain about missing types, check whether the named import was placed on the correct side (service vs protocols/common).

- [ ] **Step 6: Run gateway tests** — `cd vnext && bun test packages/gateway`

Expected: zero regressions vs Part 1 baseline.

- [ ] **Step 7: Commit**

```bash
git add vnext/packages/gateway/src vnext/packages/gateway/package.json vnext/bun.lock
git commit -m "refactor(vnext/gateway/src): migrate @vnext/interceptor imports to @vnext/service + protocols/common

8 chat-flow source files re-pointed; package.json now depends on
@vnext/service instead of @vnext/interceptor. No behavior change."
```

---

## Task 2: Migrate `gateway/tests/**`

**Scope (14 files, verified via `rg '@vnext/interceptor' vnext/packages/gateway/tests -l`):**
- `vnext/packages/gateway/tests/interceptors.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/attempt.cross.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/attempt.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/interceptors/include-usage-stream-options.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/gemini/attempt.cross.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/gemini/attempt.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/messages/attempt.cross.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/messages/attempt.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/messages/interceptors/with-context-window-error-rewritten.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/messages/interceptors/with-thinking-display-promoted.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/responses/attempt.cross.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/responses/attempt.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/with-output-item-ids-synchronized.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/with-tool-argument-whitespace-aborted.test.ts`

- [ ] **Step 1: Re-grep ground-truth** — `rg '@vnext/interceptor' vnext/packages/gateway/tests -l`

Use live list if different.

- [ ] **Step 2: Apply migration recipe** to each file

- [ ] **Step 3: Verify no leftover refs** — `rg '@vnext/interceptor' vnext/packages/gateway/tests`

Expected: empty.

- [ ] **Step 4: Run gateway tests** — `cd vnext && bun test packages/gateway`

Expected: zero regressions.

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/gateway/tests
git commit -m "refactor(vnext/gateway/tests): migrate @vnext/interceptor imports"
```

---

## Task 3: Migrate `provider-copilot/src/**`

**Scope (~21 files, verified via `rg '@vnext/interceptor' vnext/packages/provider-copilot/src -l`):**

`src/provider.ts` + everything under `src/interceptors/{chat-completions,shared,responses,messages-count-tokens,messages,embeddings}/`.

Major hot spots:
- `src/provider.ts`
- `src/interceptors/shared/with-{initiator-header,variant-and-beta-filtering,context-management-beta-aligned}.ts`
- `src/interceptors/chat-completions/{index.ts,with-cache-control-markers-attached.ts,with-vision-header.ts,with-inline-images-compressed.ts}`
- `src/interceptors/messages/*.ts` (10 files)
- `src/interceptors/responses/*.ts` (6 files)
- `src/interceptors/messages-count-tokens/{index.ts,with-count-tokens-prelude.ts}`
- `src/interceptors/embeddings/index.ts`

- [ ] **Step 1: Re-grep ground-truth** — `rg '@vnext/interceptor' vnext/packages/provider-copilot/src -l`

Save the count (`| wc -l`) — record in commit body.

- [ ] **Step 2: Update `provider-copilot/package.json`**

Add `"@vnext/service": "workspace:*"`, remove `"@vnext/interceptor": "workspace:*"`. Run `cd vnext && bun install`.

- [ ] **Step 3: Apply migration recipe** to each file

These interceptor files are stylistically uniform — most are `(_inv, _ctx, run) => run()` shaped wrappers; the swap is mechanical. Run the recipe carefully, esp. for files that import `InterceptorRun` → become `Next`. Per spec §6.2 there should be no positional `Interceptor<...>` generics in this batch (consumers use `CopilotInterceptor` alias); if grep finds any, swap arg order.

Quick verification per file: after editing, the file should compile in isolation (`cd vnext/packages/provider-copilot && bun run typecheck`) — run typecheck after every 5-7 files to catch breaks early.

- [ ] **Step 4: Verify no leftover refs** — `rg '@vnext/interceptor' vnext/packages/provider-copilot/src`

Expected: empty.

- [ ] **Step 5: Typecheck provider-copilot** — `cd vnext/packages/provider-copilot && bun run typecheck`

Expected: no errors.

- [ ] **Step 6: Run provider-copilot tests** — `cd vnext && bun test packages/provider-copilot`

Expected: zero regressions.

- [ ] **Step 7: Commit**

```bash
git add vnext/packages/provider-copilot/src vnext/packages/provider-copilot/package.json vnext/bun.lock
git commit -m "refactor(vnext/provider-copilot/src): migrate @vnext/interceptor imports

~21 interceptor files re-pointed; package.json now depends on
@vnext/service instead of @vnext/interceptor."
```

---

## Task 4: Migrate `provider-copilot/__tests__/**`

**Scope (1 file, but re-grep for accuracy):**
- `vnext/packages/provider-copilot/__tests__/count-tokens-chain.test.ts`

- [ ] **Step 1: Re-grep** — `rg '@vnext/interceptor' vnext/packages/provider-copilot/__tests__ -l`

- [ ] **Step 2: Apply migration recipe** to each file shown

- [ ] **Step 3: Verify no leftover** — `rg '@vnext/interceptor' vnext/packages/provider-copilot/__tests__`

Expected: empty.

- [ ] **Step 4: Run tests** — `cd vnext && bun test packages/provider-copilot`

- [ ] **Step 5: Commit**

```bash
git add vnext/packages/provider-copilot/__tests__
git commit -m "refactor(vnext/provider-copilot/tests): migrate @vnext/interceptor imports"
```

---

## Task 5: Sweep remaining packages and apps

Catch any consumers not covered above (e.g. provider-azure, provider-custom, provider-sdf, translate, responses-store, apps/*).

- [ ] **Step 1: Full grep** — `rg '@vnext/interceptor' vnext/packages vnext/apps -l`

Expected list:
- `vnext/packages/interceptor/package.json` (compat shim — leave for Part 3)
- `vnext/packages/interceptor/src/index.ts` (compat shim self-import — leave for Part 3)
- Nothing else

If anything else appears:

- [ ] **Step 2 (only if non-empty residue exists)**: for each non-shim file, apply the migration recipe; for each package whose source touched, update its `package.json` (add `@vnext/service`, remove `@vnext/interceptor`); run `cd vnext && bun install`.

- [ ] **Step 3: Final verification** — `rg '@vnext/interceptor' vnext/packages vnext/apps -l | rg -v 'packages/interceptor/'`

Expected: empty.

- [ ] **Step 4: Typecheck all framework + business packages** independently

```bash
cd vnext/packages/service && bun run typecheck
cd vnext/packages/protocols && bun run typecheck
cd vnext/packages/interceptor && bun run typecheck
cd vnext/packages/gateway && bun run typecheck
cd vnext/packages/provider-copilot && bun run typecheck
cd vnext/packages/provider-azure && bun run typecheck
cd vnext/packages/provider-custom && bun run typecheck
cd vnext/packages/provider-sdf && bun run typecheck
cd vnext/packages/translate && bun run typecheck
cd vnext/packages/responses-store && bun run typecheck
```

(Adjust list to actual packages present; use `ls vnext/packages` to enumerate.) Expected: all pass.

- [ ] **Step 5: Full vnext test run** — `cd vnext && bun test`

Expected: zero regressions vs pre-Spec-7 baseline.

- [ ] **Step 6: Commit (only if Step 2 made changes)**

```bash
git add vnext/packages vnext/apps vnext/bun.lock
git commit -m "refactor(vnext): finish @vnext/interceptor consumer migration sweep"
```

If nothing else needed migrating, this task closes with no commit — just record the verification in PR notes.

---

## Acceptance for Part 2

- [ ] `rg '@vnext/interceptor' vnext/packages vnext/apps -l | rg -v 'packages/interceptor/'` returns empty
- [ ] All package `package.json` files that previously had `"@vnext/interceptor": "workspace:*"` now have `"@vnext/service": "workspace:*"` instead (verify: `rg '@vnext/interceptor' vnext/packages -g 'package.json'` returns only `packages/interceptor/package.json`)
- [ ] Every framework + business package typechecks independently
- [ ] `cd vnext && bun test` — zero regressions vs Part 1 baseline
- [ ] `@vnext/interceptor` package still exists as compat shim (deletion deferred to Part 3 T7) — its `src/index.ts` and `package.json` are the only remaining mentions of the package name

---

## Rollback

Each Task 1-5 commit is independent. To rollback a batch, `git revert <sha>`; the compat shim from Part 1 keeps the reverted batch working with the (still alive) `@vnext/interceptor` import path. No lockfile drama because the shim's deps haven't changed since Part 1.

If a batch fails typecheck partway, do NOT push it. Either:
- Finish the batch (each file in scope), OR
- Stash and inspect; the compat shim means partial migration is observable but harmless to runtime.
