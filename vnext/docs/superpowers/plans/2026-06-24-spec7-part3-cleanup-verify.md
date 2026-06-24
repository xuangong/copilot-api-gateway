# Spec 7 Part 3 — Cleanup & Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the `@vnext/interceptor` compat shim package and run Spec 7's full acceptance battery. After Part 3, the `@vnext/interceptor` name is fully gone from the workspace (source, manifests, lockfile) and every package in Spec 7 §8.1 passes independent typecheck and the `cd vnext && bun test` suite is zero-regression vs the pre-Spec-7 baseline.

**Architecture:** Spec 7 §7 T7 + T8 — delete the shim, regenerate the Bun lockfile, then run the acceptance battery from spec §8.1. Single PR-quality commit for deletion + lockfile, then a no-code verification pass.

**Tech Stack:** Bun workspace, TypeScript, `bun:test`, `rg`.

**Spec reference:** [`vnext/docs/superpowers/specs/2026-06-24-spec7-service-package.md`](../specs/2026-06-24-spec7-service-package.md) §7 T7, §7 T8, §8.1

**Prerequisite:** Part 2 merged. Verification: `rg '@vnext/interceptor' vnext/packages vnext/apps -l | rg -v 'packages/interceptor/'` returns empty before starting.

**Worktree:** Continue in the Part 2 worktree, or create a fresh `spec7-part3-cleanup-verify` worktree off the post-Part-2 commit.

---

## Task 1: Delete `@vnext/interceptor` package and regenerate lockfile

**Scope:**
- Remove directory: `vnext/packages/interceptor/`
- Regenerate `vnext/bun.lock`
- (No other source files change; Part 2 already removed every non-shim import.)

- [ ] **Step 1: Pre-flight check — no live consumers**

```bash
rg '@vnext/interceptor' vnext/packages vnext/apps -l | rg -v 'packages/interceptor/'
```

Expected: empty. If non-empty, STOP — Part 2 left consumer residue. Go back and finish Part 2 before deleting the shim.

- [ ] **Step 2: Confirm shim contents are inert**

```bash
ls vnext/packages/interceptor
cat vnext/packages/interceptor/package.json
```

Expected: only `package.json`, `tsconfig.json`, `src/index.ts` (the re-export shim from Part 1 T3). No tests, no other source files. If extra files exist, inspect them — they may contain logic that was supposed to migrate.

- [ ] **Step 3: Delete the package directory**

```bash
rm -rf vnext/packages/interceptor
```

- [ ] **Step 4: Verify directory gone**

```bash
ls vnext/packages/interceptor 2>&1 || echo "OK: removed"
```

Expected: `OK: removed` (or `No such file or directory`).

- [ ] **Step 5: Regenerate lockfile**

```bash
cd vnext && bun install
```

Expected: bun reports the workspace package set without `@vnext/interceptor`; `bun.lock` is rewritten.

- [ ] **Step 6: Verify lockfile is clean of the name**

```bash
rg '@vnext/interceptor|packages/interceptor' vnext/bun.lock
```

Expected: empty.

- [ ] **Step 7: Verify no manifest still references the old package**

```bash
rg '@vnext/interceptor' vnext/packages -g 'package.json'
```

Expected: empty.

- [ ] **Step 8: Smoke typecheck — touch the most affected packages**

```bash
cd vnext/packages/service && bun run typecheck
cd ../protocols && bun run typecheck
cd ../gateway && bun run typecheck
cd ../provider-copilot && bun run typecheck
```

Expected: all four pass. If any fail with "Cannot find module '@vnext/interceptor'", a consumer was missed in Part 2 — STOP, fix, then come back (the shim is gone so the failure is real now).

- [ ] **Step 9: Quick test pulse**

```bash
cd vnext && bun test packages/gateway packages/provider-copilot
```

Expected: zero regressions vs Part 2 baseline. (Full battery is Task 2.)

- [ ] **Step 10: Commit**

```bash
git add -A vnext/packages vnext/bun.lock
git commit -m "refactor(vnext): delete @vnext/interceptor compat shim package

Part 2 migrated all consumers to @vnext/service + @vnext/protocols/common.
The shim from Part 1 T3 is no longer reachable; remove the package
directory and regenerate bun.lock."
```

---

## Task 2: Full Spec 7 §8.1 acceptance battery

This task does NOT modify code — it runs the verifications listed in spec §8.1 and records the results. If any check fails, fix it (likely by amending Task 1 or revisiting a Part 2 batch), do not paper over.

- [ ] **Step 1: Full test suite — zero regressions**

```bash
cd vnext && bun test
```

Expected: all green. Baseline = the pre-Spec-7 test run captured before Part 1 began. If new failures appear, identify which Spec 7 task introduced them (`git bisect` across the Spec 7 commits) and fix at the source.

- [ ] **Step 2: Independent typecheck — `@vnext/service`**

```bash
cd vnext/packages/service && bun run typecheck
```

Expected: pass.

- [ ] **Step 3: Independent typecheck — `@vnext/protocols`**

```bash
cd vnext/packages/protocols && bun run typecheck
```

Expected: pass.

- [ ] **Step 4: Independent typecheck — `@vnext/gateway`**

```bash
cd vnext/packages/gateway && bun run typecheck
```

Expected: pass.

- [ ] **Step 5: Independent typecheck — remaining framework + business packages**

```bash
for pkg in provider-copilot provider-azure provider-custom provider-sdf translate responses-store platform shared-http shared-cache; do
  if [ -d "vnext/packages/$pkg" ]; then
    echo "=== $pkg ==="
    (cd vnext/packages/$pkg && bun run typecheck) || echo "FAIL: $pkg"
  fi
done
```

Expected: every present package passes. Skip silently if a directory is absent (script structure tolerates that).

- [ ] **Step 6: Smoke check — service package has no @vnext/* runtime deps**

```bash
rg '@vnext/' vnext/packages/service/package.json
```

Expected: empty. If anything appears, inspect whether it slipped into `dependencies` (forbidden) vs `devDependencies` (allowed for tooling only — but Spec 7 §4 surface says service has no dev tooling deps either; investigate before accepting).

- [ ] **Step 7: Smoke check — service package nowhere imports @vnext/protocols**

```bash
rg '@vnext/protocols' vnext/packages/service
```

Expected: empty. (Charter §6 contract A: framework packages must not import business packages.)

- [ ] **Step 8: Smoke check — `@vnext/interceptor` fully extinct**

```bash
rg '@vnext/interceptor|packages/interceptor' vnext/packages vnext/apps vnext/bun.lock
```

Expected: empty.

- [ ] **Step 9: Apps smoke run (manual / optional but recommended)**

If the worktree has `apps/platform-bun` or `apps/platform-cloudflare`, do a build/start dry-run to catch any import resolution that test suites missed:

```bash
cd vnext/apps/platform-bun && bun run typecheck 2>&1 | tail -20
# (optional) cd vnext/apps/platform-cloudflare && bun run typecheck
```

Expected: pass. If `typecheck` script is absent, skip; the test suite in Step 1 already exercises the app boundary.

- [ ] **Step 10: Record acceptance**

No commit needed — Task 2 is verification only. Append a short note to the PR description (or open one if you're staging Part 3 separately):

```
Spec 7 acceptance battery (per spec §8.1):
- [x] cd vnext && bun test — all green vs pre-Spec-7 baseline
- [x] service / protocols / gateway typecheck independently
- [x] service/package.json has no @vnext/* deps
- [x] vnext/packages/service has no @vnext/protocols import
- [x] @vnext/interceptor fully removed (src, manifests, bun.lock)
- [x] All other framework + business packages typecheck
```

If Step 9 was executed, add a line for it.

---

## Acceptance for Part 3 (= Spec 7 §8.1 verbatim)

- [ ] `cd vnext && bun test` — zero new failing tests vs pre-Spec-7 baseline
- [ ] `cd vnext/packages/service && bun run typecheck` — passes
- [ ] `cd vnext/packages/protocols && bun run typecheck` — passes
- [ ] `cd vnext/packages/gateway && bun run typecheck` — passes
- [ ] `vnext/packages/service/package.json` has no `@vnext/*` entries in `dependencies`
- [ ] `rg '@vnext/protocols' vnext/packages/service` returns empty
- [ ] `vnext/packages/interceptor/` directory does not exist
- [ ] `rg '@vnext/interceptor|packages/interceptor' vnext/packages vnext/apps vnext/bun.lock` returns empty

(Spec §8.2 items — dependency-cruiser, echo proxy, API surface review — are explicitly deferred to later specs and NOT part of Part 3 acceptance.)

---

## Rollback

Part 3 is a single deletion commit + verification. Rollback strategy:

- **If Task 1 commit causes regressions discovered after merge:** `git revert <Task 1 sha>` restores `vnext/packages/interceptor/` and the old `bun.lock`. The shim is fully self-contained re-export code; restoring it makes consumers work again as long as Part 2's migrations are preserved (they should be — Part 2 consumers point to `@vnext/service` + `@vnext/protocols/common` directly and don't need the shim). After revert, investigate, fix, re-attempt deletion.
- **If Task 2 verification fails for a non-deletion reason** (e.g. a long-tail bug surfaces in `bun test`): the deletion in Task 1 is independent of the failing test — fix the failing test on its own, do not revert Task 1.

## Notes for the implementer

- Task 1 is the only Part 3 commit. Task 2 produces no commits — just PR-notes evidence.
- Do not be tempted to bundle Spec 8 prep (e.g. moving `Invocation` to `protocols-llm`) into this PR; that explicitly belongs to Spec 8 per spec §9.
- If Step 8 in Task 1 reveals a missed consumer, do NOT add the shim back — finish migrating the consumer (apply Part 2's migration recipe to that file) and continue.
