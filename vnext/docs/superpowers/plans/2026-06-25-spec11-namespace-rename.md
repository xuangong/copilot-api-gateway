# Spec 11 — Namespace Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename all 19 vNext workspace packages from `@vnext-gateway/*` / `@vnext-llm/*` to `@vibe-core/*` / `@vibe-llm/*` as a pure codemod, verified by tests + workspace-wide typecheck baseline diff + local docker 4-endpoint smoke.

**Architecture:** Single PR / single continuous operation. Mechanical sed across `packages` + `apps` + `scripts` + select config + `bun.lock`; semantic edit of `check-framework-purity.ts` (cannot be sed'd — must update framework prefix detection, business prefix detection, bare-namespace ban, and retain legacy `@vnext-*` anti-regression detection). `bun install` is the only workspace re-resolution step (no `rm -rf node_modules`); `bun.lock` diff is gated to workspace renames only. No source logic, no test changes, no physical directory renames, no CFW deploy.

**Tech Stack:** Bun 1.x workspace monorepo, TypeScript, ripgrep (rg), BSD sed (macOS), docker / docker-compose.

**Source spec:** `vnext/docs/superpowers/specs/2026-06-25-spec11-namespace-rename.md`

**Execution constraints (from memory `spec8_execution_constraints`):** stay on vNext branch, NO push, NO merge to main, NO CFW deploy. Local docker test is mandatory.

---

## Conventions

**All commands execute from repo root** (`/Users/zhangxian/projects/copilot-api-gateway`). Bun commands MUST be wrapped in `(cd vnext && ...)` subshell — running `bun run <script>` from repo root will execute the **root** `package.json` script (e.g. root `bun run typecheck` runs `bunx tsc --noEmit` on root `src/`, not the vNext workspace).

**sed flavor:** BSD sed (macOS). `sed -i ''` (empty backup ext required). Plan commands use `|` as delimiter to avoid escaping `/` in package paths.

**Branch:** `vNext`. Do NOT switch branches, do NOT push, do NOT merge to main.

**Single commit at the end.** Do NOT split into multiple commits — the workspace is in a broken intermediate state between the sed step and the purity-script semantic edit; bisection is not useful for a mechanical rename.

---

## File Inventory

### Files modified by Task 2 (mechanical sed)

19 workspace package manifests (`"name"` + intra-workspace `dependencies` / `devDependencies`):

Framework (7) — `@vnext-gateway/*` → `@vibe-core/*`:
- `vnext/packages/platform/package.json`
- `vnext/packages/http/package.json`
- `vnext/packages/cache/package.json`
- `vnext/packages/result/package.json`
- `vnext/packages/upstream/package.json`
- `vnext/packages/service/package.json`
- `vnext/packages/chat-flow-kit/package.json`

Business (12) — `@vnext-llm/*` → `@vibe-llm/*`:
- `vnext/packages/protocols-llm/package.json` (name: `@vnext-llm/protocols`)
- `vnext/packages/translate/package.json`
- `vnext/packages/responses-store/package.json`
- `vnext/packages/provider-llm/package.json`
- `vnext/packages/provider-copilot/package.json`
- `vnext/packages/provider-azure/package.json`
- `vnext/packages/provider-custom/package.json`
- `vnext/packages/provider-sdf/package.json`
- `vnext/packages/gateway/package.json`
- `vnext/apps/dashboard/package.json`
- `vnext/apps/platform-bun/package.json`
- `vnext/apps/platform-cloudflare/package.json`

Source / config files (touched in bulk by sed, count not fixed):
- All `.ts` / `.tsx` under `vnext/packages/**` and `vnext/apps/**` with import statements of the renamed scopes
- `vnext/tsconfig.base.json` if it has `paths` mappings (verify; current file may not)
- `vnext/eslint.config.mjs` if it has scope literals (verify; current file may not)
- `vnext/bun.lock` — workspace name entries

### Files modified semantically by Task 3 (NOT sed)

- `vnext/scripts/check-framework-purity.ts` — sed would either over-rewrite (breaking the anti-regression legacy detection) or under-rewrite (leaving stale framework/business prefix detection). Must be hand-edited.

### Files NOT modified

- `vnext/apps/platform-bun/Dockerfile` — `COPY packages/<dir>/package.json packages/<dir>/` uses **physical directory names**, which do not change.
- Root `vnext/package.json` (`"name": "copilot-gateway-vnext"`) — deferred to Roadmap Step 7.
- Physical directory names (e.g. `packages/chat-flow-kit/` stays as-is).
- `vnext/docs/superpowers/specs/**` and `vnext/docs/superpowers/research/**` — historical snapshots, keep old names as timestamp evidence.
- Class names, interface names, file names.

### Files / paths created by this plan

- `/tmp/spec11-typecheck-baseline.txt` — Task 1 captures pre-rename typecheck output.
- `/tmp/spec11-typecheck-after.txt` — Task 6 captures post-rename typecheck output.
- `/tmp/spec11-occurrence-baseline.txt` — Task 1 captures pre-rename occurrence count.

(All three are gitignored by living in `/tmp`; do not commit.)

---

## Task 1: Lock baselines (test pass / occurrence count / typecheck snapshot)

**Files:**
- Read: `vnext/packages/**/package.json`, `vnext/apps/**/package.json`
- Create: `/tmp/spec11-typecheck-baseline.txt`, `/tmp/spec11-occurrence-baseline.txt`

**Why:** Acceptance gates A1/A2/A4 compare against pre-rename state. If you don't capture baselines first, you cannot prove later that rename was neutral. A2 in particular cannot use a hardcoded "expected errors" list because the workspace's pre-existing errors drift over time (Spec 8 / Spec 10 documented translate + provider-azure/custom/sdf BodyInit errors, but the exact line numbers can shift).

- [ ] **Step 1: Verify clean git state**

Run from repo root:

```bash
git status
git branch --show-current
```

Expected: branch is `vNext`; working tree clean (no uncommitted changes). If dirty, stop and ask the user how to handle the diff before proceeding.

- [ ] **Step 2: Verify pre-rename test suite green**

Run from repo root:

```bash
(cd vnext && bun run test) 2>&1 | tail -5
```

Expected last line: `1001 pass` and `0 fail`. If anything other than 1001/0, stop — the spec assumes a green baseline. Investigate the delta with the user before continuing.

- [ ] **Step 3: Capture pre-rename occurrence count**

Run from repo root:

```bash
rg -o '@vnext-(gateway|llm)' vnext/packages vnext/apps | wc -l | tee /tmp/spec11-occurrence-baseline.txt
```

Expected: a single integer (recent measurement was 604 occurrences across `packages` + `apps`). The exact number does not matter — what matters is that you write it down, because Task 8 verifies post-rename `@vibe-(core|llm)` count is within ±5 of this.

`vnext/scripts/` is intentionally excluded — `check-framework-purity.ts` carries ~13 legacy `@vnext-*` detection literals which are kept by design (Task 3) and would otherwise skew the conservation gate.

- [ ] **Step 4: Capture pre-rename typecheck baseline**

Run from repo root:

```bash
(cd vnext && bun run typecheck) 2>&1 | tee /tmp/spec11-typecheck-baseline.txt
```

Expected: command exits non-zero (pre-existing errors are known). The file will contain:
- `@vnext-llm/translate` Gemini-related TS errors
- `@vnext-llm/provider-azure` / `provider-custom` / `provider-sdf` `BodyInit` TS errors

Do NOT attempt to fix these — they are the baseline. Spec 8 A2 explicitly tolerates them.

- [ ] **Step 5: Sanity-check baseline files**

Run from repo root:

```bash
wc -l /tmp/spec11-typecheck-baseline.txt /tmp/spec11-occurrence-baseline.txt
cat /tmp/spec11-occurrence-baseline.txt
```

Expected: typecheck file has tens-to-hundreds of lines; occurrence file has 1 line containing a 3-digit integer (~600). If either is empty, redirect failed — re-run the relevant capture step.

- [ ] **Step 6: No commit**

This task produces no git changes. The captured files live in `/tmp` and are inputs for later acceptance gates. Move on to Task 2.

---

## Task 2: Mechanical sed rename across code + config + lock

**Files modified:**
- All files matched by `rg -l '@vnext-gateway'` and `rg -l '@vnext-llm'` within `vnext/packages`, `vnext/apps`, `vnext/scripts`, `vnext/tsconfig.base.json`, `vnext/eslint.config.mjs`, `vnext/bun.lock`
- Net effect: 19 workspace manifest `"name"` + intra-workspace `dependencies` updated; every `.ts`/`.tsx` import of the renamed scopes updated; `bun.lock` workspace entries renamed

**Why:** Bun workspace resolution is name-based. Partial renames (e.g. manifest renamed but importers not) break the entire workspace install and the dependency graph fails to resolve. The whole monorepo must flip in one shot, then `bun install` reconciles `bun.lock` in Task 4.

**Why include `vnext/scripts/`:** Task 3 will hand-edit `check-framework-purity.ts` afterward. Running sed across `scripts/` first is convenient (it converts the four production rules to the new scope), then Task 3 restores the legacy `@vnext-*` regex literals as anti-regression detection.

- [ ] **Step 1: Rewrite `@vnext-gateway` → `@vibe-core` across the targeted tree**

Run from repo root:

```bash
rg -l '@vnext-gateway' \
  vnext/packages vnext/apps vnext/scripts \
  vnext/tsconfig.base.json vnext/eslint.config.mjs vnext/bun.lock \
  2>/dev/null \
  | xargs sed -i '' 's|@vnext-gateway|@vibe-core|g'
```

Notes:
- `2>/dev/null` swallows `rg`'s "file not found" stderr if `tsconfig.base.json` / `eslint.config.mjs` don't contain the scope (`rg -l` exits 1 silently in that case but `xargs` won't crash because the list still includes the files that do match).
- `sed -i ''` is BSD sed (macOS). On Linux use `sed -i` (no empty string).
- The `|` delimiter avoids escaping the `/` in scope paths.
- `node_modules` is automatically excluded by ripgrep's default ignore behavior.

- [ ] **Step 2: Rewrite `@vnext-llm` → `@vibe-llm` across the targeted tree**

Run from repo root:

```bash
rg -l '@vnext-llm' \
  vnext/packages vnext/apps vnext/scripts \
  vnext/tsconfig.base.json vnext/eslint.config.mjs vnext/bun.lock \
  2>/dev/null \
  | xargs sed -i '' 's|@vnext-llm|@vibe-llm|g'
```

- [ ] **Step 3: Verify zero `@vnext-(gateway|llm)` residue in code/config/lock (excluding purity script)**

Run from repo root:

```bash
rg '@vnext-(gateway|llm)' \
  vnext/packages vnext/apps \
  vnext/tsconfig.base.json vnext/eslint.config.mjs vnext/bun.lock
```

Expected: returns empty (exit code 1). If anything matches, sed failed to cover it — investigate the offending file and decide whether sed needs a wider include or the file is something we explicitly do NOT rename (in which case, document the exception).

Note: this command intentionally does NOT include `vnext/scripts/` — Task 3 is about to add legacy `@vnext-*` literals back there.

- [ ] **Step 4: Verify new scope occurrence count within ±5 of baseline**

Run from repo root:

```bash
AFTER=$(rg -o '@vibe-(core|llm)' vnext/packages vnext/apps | wc -l)
BEFORE=$(cat /tmp/spec11-occurrence-baseline.txt)
echo "before=$BEFORE after=$AFTER delta=$((AFTER - BEFORE))"
```

Expected: `|delta| <= 5`. A small delta is acceptable because sed may merge or split occurrences on lines that had two scope mentions (e.g. dependency block with both `@vnext-gateway/foo` and a comment). A delta over ±5 means something unintended happened — likely sed touched a file it shouldn't have. Inspect `git diff --stat | head -30` and investigate.

- [ ] **Step 5: Spot-check one framework manifest and one business manifest**

Run from repo root:

```bash
rg '"name"' vnext/packages/platform/package.json vnext/packages/gateway/package.json
```

Expected:
```
vnext/packages/platform/package.json:  "name": "@vibe-core/platform",
vnext/packages/gateway/package.json:  "name": "@vibe-llm/gateway",
```

If either still shows `@vnext-*`, Step 1 or 2 missed it. Re-run sed on that specific file and investigate why ripgrep didn't list it.

- [ ] **Step 6: Spot-check one TS source import**

Run from repo root:

```bash
rg "from '@vibe-(core|llm)/" vnext/packages/gateway/src | head -3
```

Expected: at least 3 hits showing imports rewritten (the exact files don't matter as long as the imports use the new scope). Empty output means sed didn't touch source files — that's a critical failure; abort and investigate.

- [ ] **Step 7: No commit**

The tree is in a deliberately broken intermediate state (purity script still references `@vibe-*` everywhere because sed rewrote it; legacy detection is missing). Task 3 fixes that. Single commit happens in Task 10.

---

## Task 3: Semantic edit of `check-framework-purity.ts`

**Files modified:**
- `vnext/scripts/check-framework-purity.ts`

**Why sed cannot handle this file:** the script has two distinct categories of scope literals:
1. **Production detection rules** (the prefixes it enforces as framework / business): these SHOULD be rewritten to `@vibe-core/` and `@vibe-llm/`.
2. **Anti-regression legacy detection** (catches anyone re-introducing the old scopes by habit): these MUST keep the old `@vnext-*` strings as literals.

Sed treats both identically and produces a script that either bans the new scopes (if sed overshoots) or fails to ban the old ones (if sed undershoots). The reviewer must read each scope literal and decide which category it belongs to.

**Reference for current state:** the script was last reviewed at `vnext/scripts/check-framework-purity.ts:67-105` — lines 70/73 define the regexes, line 88 detects framework packages by manifest name prefix, line 95 enforces no-cross-scope deps. After Task 2 sed pass, those literals are all `@vibe-*`; this task restores legacy `@vnext-*` detection and tightens the bare-namespace ban.

- [ ] **Step 1: Read current state of the script**

Run from repo root:

```bash
cat vnext/scripts/check-framework-purity.ts
```

Note the regex declarations (around lines 70 / 73 in the pre-Spec-11 version, line numbers will have shifted after Task 2 sed). The current production regex names are `UNSCOPED_VNEXT` and `LLM_IMPORT`. After sed, the bodies will read `@vibe/` / `@vibe-llm/`. Production detection of "no bare `@vnext/*`" no longer makes sense as written — bare `@vnext/*` is a historical concern; the new equivalent rule is "no bare `@vibe/*` — always use `@vibe-core/*` or `@vibe-llm/*`".

- [ ] **Step 2: Rewrite the script with the four required changes**

Open `vnext/scripts/check-framework-purity.ts` and make these four edits (use Edit tool with exact strings — the file is small enough to read and edit in place):

**Edit 2a — rename production framework detection prefix.** The framework-package detection at the (renumbered) `manifest.name?.startsWith(...)` line currently reads `'@vibe-core/'` (sed already rewrote it). That is correct — leave it.

**Edit 2b — rename production cross-scope-dep check.** The manifest dependency-iteration check that rejects `dep.startsWith('@vibe-llm/')` is also already correct post-sed. Leave it.

**Edit 2c — rebuild the bare-namespace rule.** The constant currently named `UNSCOPED_VNEXT` was a regex matching `@vnext/foo` (bare scope, no `-gateway` / `-llm`). After sed it now matches `@vibe/foo`. Rename the constant to `UNSCOPED_VIBE` and confirm the regex body is:

```ts
const UNSCOPED_VIBE = /(?:from|import)\s*\(?\s*['"]@vibe\/[a-z0-9-]+/i
```

Update the violation reason string from `'un-scoped @vnext/* import (use @vnext-gateway/* or @vnext-llm/*)'` to `'un-scoped @vibe/* import (use @vibe-core/* or @vibe-llm/*)'`. Also update all usages of `UNSCOPED_VNEXT` in the file (there is at least one inside the `scanFile(...)` block) to `UNSCOPED_VIBE`.

**Edit 2d — restore legacy `@vnext-*` anti-regression detection.** Below `UNSCOPED_VIBE`, add a third regex that catches any reintroduction of the old scopes:

```ts
// Anti-regression: reject any re-introduction of legacy @vnext-(gateway|llm)/* or bare @vnext/*
// after Spec 11 namespace rename. These literals are intentional — do NOT rewrite to @vibe-*.
const LEGACY_VNEXT = /(?:from|import)\s*\(?\s*['"]@vnext(?:-(?:gateway|llm))?\/[a-z0-9-]+/i
```

Then add a `scanFile(file, ...)` invocation inside the existing `walk(pkgPath, (file) => { ... })` block that runs this regex against every source file (framework AND business packages — legacy scope is forbidden everywhere). The reason string should be:

```
'legacy @vnext-* import re-introduced (Spec 11 renamed to @vibe-core/* or @vibe-llm/*)'
```

- [ ] **Step 3: Verify the four edits are present**

Run from repo root:

```bash
rg -n 'UNSCOPED_VIBE|LEGACY_VNEXT|@vnext-(gateway|llm)' vnext/scripts/check-framework-purity.ts
```

Expected matches:
- `UNSCOPED_VIBE` declaration + at least one usage line
- `LEGACY_VNEXT` declaration + at least one usage line
- Legacy `@vnext-*` literals appear ONLY inside `LEGACY_VNEXT` regex and its comment / reason string (not in framework/business prefix detection)

If `@vnext-(gateway|llm)` shows up in `manifest.name?.startsWith(...)` or in the cross-scope-dep `startsWith(...)` check, Step 2 missed those — they must be `@vibe-core/` and `@vibe-llm/` respectively.

- [ ] **Step 4: Type-check the script in isolation (smoke)**

Run from repo root:

```bash
(cd vnext && bunx tsc --noEmit scripts/check-framework-purity.ts 2>&1) | head -20
```

Expected: no type errors specific to the script (it may emit errors caused by missing project-wide config when run standalone — those are OK as long as none point inside `scripts/check-framework-purity.ts`). If the script itself has TS errors, fix them before continuing.

- [ ] **Step 5: No commit**

Script is correct but `bun install` hasn't reconciled `bun.lock` yet. Task 4 handles install + lock-diff gate.

---

---

### Task 4: Refresh bun.lock + lock-diff gate

**Files:**
- Modify: `vnext/bun.lock` (regenerated by `bun install`; only workspace name rows should change)

- [ ] **Step 1: Run install in vnext workspace**

```bash
(cd vnext && bun install)
```

Expected: Bun re-resolves the workspace graph. Does NOT delete `node_modules`. `bun.lock` is rewritten only where workspace names changed. No `Error` lines; warnings about peer deps that already existed pre-rename are tolerated (they were in the baseline).

- [ ] **Step 2: Lock-diff gate (A4.1)**

```bash
git diff -- vnext/bun.lock | rg '^[+-]' | rg -v '^(\+\+\+|---)' | rg -v '@(vnext|vibe)-'
```

Expected: returns empty. Every `+`/`-` line in `bun.lock` must contain either `@vnext-` (removed workspace name) or `@vibe-` (added workspace name). Any other diff line means a third-party version drifted and must be investigated before continuing.

If non-empty:
1. Inspect each offending line.
2. Most common cause: an unrelated dep was re-resolved because its `peerDependencies` matched a renamed workspace. Decide whether to accept (very rare, document in commit) or roll back.
3. Rollback: `git checkout -- vnext/bun.lock && (cd vnext && bun install)` and re-investigate. Do NOT proceed past this gate with non-workspace diff lines.

- [ ] **Step 3: No commit**

Continue.

---

### Task 5: Workspace test gate (A1)

- [ ] **Step 1: Run the test suite from vnext**

```bash
(cd vnext && bun run test)
```

Expected: `1001 pass, 0 fail`. This matches Spec 10 acceptance log (`/Users/zhangxian/projects/copilot-api-gateway/vnext/docs/superpowers/research/2026-06-25-spec10-acceptance-log.md` A1). The pre-test framework purity gate from Task 7 also runs here if it is wired into `bun run test`; either way Task 7 re-runs it standalone.

- [ ] **Step 2: If any test fails**

1. Capture failing test names.
2. Most likely culprit: a sed false-positive in a string literal or comment that some test asserts against. `rg '@vnext-(gateway|llm)' vnext/packages vnext/apps` — should return empty after Task 2. If non-empty, that file was missed.
3. Second most likely: a `paths` mapping that sed missed. Check `vnext/tsconfig.base.json`.
4. Fix in place, re-run `(cd vnext && bun run test)`. Do NOT commit until A1 is green.

- [ ] **Step 3: No commit**

Continue.

---

### Task 6: Typecheck gate with normalized diff (A2)

**Files:**
- Read: `/tmp/spec11-typecheck-baseline.txt` (from Task 1)
- Create: `/tmp/spec11-typecheck-after.txt`

- [ ] **Step 1: Capture post-rename typecheck output**

```bash
normalize() { sed 's/@vibe-core/@vnext-gateway/g; s/@vibe-llm/@vnext-llm/g'; }
(cd vnext && bun run typecheck) 2>&1 | normalize > /tmp/spec11-typecheck-after.txt
```

Expected: file written. Exit code from `bun run typecheck` may be non-zero — that's fine, the baseline also has pre-existing errors (translate Gemini + provider-azure/custom/sdf BodyInit). We only care about the diff.

- [ ] **Step 2: Diff against baseline**

```bash
normalize() { sed 's/@vibe-core/@vnext-gateway/g; s/@vibe-llm/@vnext-llm/g'; }
normalize < /tmp/spec11-typecheck-baseline.txt | diff - /tmp/spec11-typecheck-after.txt
```

Expected: empty diff. After normalizing both sides (so the literal `@vnext-*` ↔ `@vibe-*` Bun prefix substitution is masked), the file paths, line numbers, and TS error codes must be identical to the baseline. Any new error = rename introduced a real regression.

- [ ] **Step 3: If diff is non-empty**

1. Read the diff carefully. New errors will appear as `>` lines after normalization.
2. Common cause: a `paths` alias in `tsconfig.base.json` not updated, so `import type` resolution fails. Fix the path.
3. Less common: a `package.json` `exports` block referencing an old scope. Fix and re-run.
4. Re-capture step 1, re-diff. Do NOT proceed until diff is empty.

- [ ] **Step 4: No commit**

Continue.

---

### Task 7: Framework purity gate (re-run standalone)

- [ ] **Step 1: Execute the purity script**

```bash
(cd vnext && bun run scripts/check-framework-purity.ts)
```

Expected: `[framework-purity] OK` and exit 0.

The script (edited in Task 3) now enforces three rules:
1. Framework packages (`@vibe-core/*`) must not depend on `@vibe-llm/*` (manifest + imports)
2. No bare `@vibe/*` un-scoped imports
3. **Legacy guard:** no `@vnext-*` or `@vnext-(gateway|llm)/*` imports anywhere — these are anti-regression sentinels for Spec 11

- [ ] **Step 2: If violations are reported**

The script prints `file:line  →  matched substring` for each violation. Three categories:

- `@vnext-*` or `@vnext-(gateway|llm)/*` → Task 2 sed missed this file. Inspect the file, re-run targeted sed, then re-run this task.
- `@vibe/...` (bare) → Someone hand-wrote a bare import. Convert to `@vibe-core/...` or `@vibe-llm/...` per package boundary.
- `@vibe-core/...` depending on `@vibe-llm/...` → Pre-existing framework-purity violation surfaced by the rename. Should NOT happen if Spec 8/10 left the boundary clean. If it does, escalate — this is out of Spec 11 scope.

- [ ] **Step 3: No commit**

Continue.

---

### Task 8: Docker build gate (A5)

**Files:**
- Read: `vnext/apps/platform-bun/Dockerfile` (NOT modified — uses physical dir names per Spec 11 §3.2)

- [ ] **Step 1: Build image from repo root with vnext/ as build context**

```bash
docker build --no-cache -f vnext/apps/platform-bun/Dockerfile -t vnext-platform-bun:spec11 vnext
```

Expected: build succeeds. Key checkpoint: the `RUN bun install --frozen-lockfile` stage must resolve every `@vibe-core/*` and `@vibe-llm/*` workspace package without `error: workspace package not found` or `Saved lockfile` warnings (the latter would mean lock drift, which Task 4 already gated against).

- [ ] **Step 2: If build fails**

1. `bun install --frozen-lockfile` failure → lock-diff drift escaped Task 4. Re-run Task 4 step 2.
2. `COPY` failure for `packages/<dir>/package.json` → check Dockerfile lines 14-32. Physical dir names must match `ls vnext/packages/`. Spec 11 does NOT rename physical dirs, so this should be unchanged from Spec 10's known-green Dockerfile (Spec 10 acceptance log A6).
3. `bun run build:ui` failure → unrelated to Spec 11, likely pre-existing dashboard issue. Escalate.

- [ ] **Step 3: No commit**

Continue.

---

### Task 9: Local docker compose + 4-endpoint smoke (A6)

**Files:**
- Read: `docker-compose.vnext.yml` (project root, NOT modified)
- Read: `.env.vnext` (project root, NOT modified)

- [ ] **Step 1: Bring up the stack from repo root**

```bash
docker compose --env-file .env.vnext -f docker-compose.vnext.yml up -d
```

Expected: container `copilot-gateway-vnext` (or similarly named per compose file) starts. Wait ~5s for readiness.

- [ ] **Step 2: Health check (optional but recommended)**

```bash
docker compose -f docker-compose.vnext.yml logs --tail=30 | rg -i 'error|listening|ready' || true
```

Expected: see a "listening on :41415" or equivalent line, no startup errors.

- [ ] **Step 3: Smoke `/v1/chat/completions` (OpenAI shape)**

Use the same model id from Spec 10 acceptance log A6.5:

```bash
curl -sS -o /tmp/spec11-smoke-cc.json -w '%{http_code}\n' \
  -X POST http://localhost:41415/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer test' \
  -d '{"model":"gpt-4o-mini-2024-07-18","messages":[{"role":"user","content":"reply with the single word: ok"}]}'
```

Expected: `200`. `cat /tmp/spec11-smoke-cc.json | jq .choices[0].message.content` non-empty.

- [ ] **Step 4: Smoke `/v1/messages` (Anthropic shape)**

```bash
curl -sS -o /tmp/spec11-smoke-msg.json -w '%{http_code}\n' \
  -X POST http://localhost:41415/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-api-key: test' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-opus-4.6","max_tokens":32,"messages":[{"role":"user","content":"reply with: ok"}]}'
```

Expected: `200`. `cat /tmp/spec11-smoke-msg.json | jq .content[0].text` non-empty.

- [ ] **Step 5: Smoke `/v1/responses` (OpenAI Responses shape)**

```bash
curl -sS -o /tmp/spec11-smoke-resp.json -w '%{http_code}\n' \
  -X POST http://localhost:41415/v1/responses \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer test' \
  -d '{"model":"gpt-5.4-mini","input":"reply with: ok"}'
```

Expected: `200`. `cat /tmp/spec11-smoke-resp.json | jq .output[0]` non-empty.

- [ ] **Step 6: Smoke `/v1beta/.../generateContent` (Gemini shape, cross-protocol)**

```bash
curl -sS -o /tmp/spec11-smoke-gemini.json -w '%{http_code}\n' \
  -X POST 'http://localhost:41415/v1beta/models/gemini-2.5-pro:generateContent' \
  -H 'content-type: application/json' \
  -H 'x-goog-api-key: test' \
  -d '{"contents":[{"role":"user","parts":[{"text":"reply with: ok"}]}]}'
```

Expected: `200`. `cat /tmp/spec11-smoke-gemini.json | jq .candidates[0].content.parts[0].text` non-empty.

- [ ] **Step 7: If any endpoint fails**

1. Capture response body: `cat /tmp/spec11-smoke-<name>.json`
2. Capture container logs around the failure: `docker compose -f docker-compose.vnext.yml logs --tail=50`
3. Distinguish:
   - HTTP 4xx with error message about upstream auth → expected if `.env.vnext` lacks valid keys; not a Spec 11 regression. Document and continue if other endpoints pass.
   - HTTP 5xx with stack trace mentioning `@vibe-*` import or "Cannot find module" → real Spec 11 regression. Stop. Compare against Spec 10's known-green run (acceptance log A6.5) and trace the missing import.
4. Do NOT bring down the stack until you've inspected logs.

- [ ] **Step 8: Tear down**

```bash
docker compose -f docker-compose.vnext.yml down
```

- [ ] **Step 9: No commit**

Continue.

---

### Task 10: Single commit

- [ ] **Step 1: Final pre-commit verification**

```bash
# A3 — old name zero residue (excluding allowlisted purity script)
rg '@vnext-(gateway|llm)' vnext/packages vnext/apps vnext/tsconfig.base.json vnext/eslint.config.mjs vnext/bun.lock
# Expected: empty

# A4 — new name occurrence near baseline
echo "after: $(rg -o '@vibe-(core|llm)' vnext/packages vnext/apps | wc -l)"
cat /tmp/spec11-occurrence-baseline.txt
# Expected: |after - baseline| ≤ 5
```

If either gate fails, fix in place before committing.

- [ ] **Step 2: Review staged changes one final time**

```bash
git status
git diff --stat
```

Expected files:
- ~19 `packages/*/package.json` and `apps/*/package.json` (workspace name + workspace dep refs)
- `vnext/packages/**/*.ts`, `vnext/apps/**/*.ts(x)` (imports)
- `vnext/tsconfig.base.json` (paths, if present)
- `vnext/eslint.config.mjs` (if present)
- `vnext/scripts/check-framework-purity.ts` (semantic edit from Task 3)
- `vnext/bun.lock` (workspace name rows only — already gated in Task 4)

No unexpected files. No physical dir renames. No `vnext/docs/specs/` or `vnext/docs/research/` edits.

- [ ] **Step 3: Stage and commit**

```bash
git add vnext/packages vnext/apps vnext/scripts/check-framework-purity.ts vnext/bun.lock
# Conditionally add only if modified by sed:
git diff --quiet vnext/tsconfig.base.json || git add vnext/tsconfig.base.json
git diff --quiet vnext/eslint.config.mjs || git add vnext/eslint.config.mjs

git commit -m "$(cat <<'MSG'
refactor(vnext/spec11): rename @vnext-* namespaces to @vibe-*

Pure codemod per vnext/docs/superpowers/specs/2026-06-25-spec11-namespace-rename.md.

- @vnext-gateway/* → @vibe-core/* (7 framework packages)
- @vnext-llm/*     → @vibe-llm/*  (12 business packages)
- scripts/check-framework-purity.ts: enforce new prefixes, ban bare @vibe/*,
  retain legacy @vnext-* detection as anti-regression sentinel
- bun.lock refreshed; diff limited to workspace renames (A4.1 verified)

Acceptance: A1 1001 pass / A2 normalized typecheck diff empty / A3 zero
residue in packages+apps / A4 occurrence conserved / A5 docker build green
/ A6 4-endpoint local docker smoke green. A7 (CFW live) deferred per
spec8_execution_constraints.

No source logic changes, no physical dir renames, no doc rewrites
(specs/research preserved as historical snapshots).

Generated with Claude Code via Happy
Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>
MSG
)"
```

- [ ] **Step 4: Verify commit landed**

```bash
git log -1 --stat
```

Expected: one commit on `vNext` branch, ~25-35 files changed. NO push (per `spec8_execution_constraints`).

- [ ] **Step 5: Done**

Spec 11 acceptance gates A1-A6 all green. A7 (CFW live) parked for next deploy window per execution constraints.

---

## Self-Review

(Reviewed inline against `vnext/docs/superpowers/specs/2026-06-25-spec11-namespace-rename.md`.)

**Spec coverage:**
- §1 scope (no logic / no physical rename / no root `package.json` name / no CFW / no push) → Task 10 commit-only, no push; Task 8 docker local only; physical dirs untouched in Task 2 sed targets.
- §2 mapping (7 + 12) → Task 2 sed covers both prefixes; Task 10 step 1 verifies via `rg`.
- §3 change sites → Task 2 sed file list matches §3.1; Task 3 covers `check-framework-purity.ts`; Task 10 step 2 confirms expected file set.
- §3.3 baseline → Task 1 step 3 captures occurrence count; Task 1 step 4 captures typecheck baseline.
- §4 single-PR rationale → Task 10 single commit.
- §5 12 steps → mapped 1:1 (Task 1 = spec steps 1; Task 2 = step 2; Task 3 = step 3; Task 4 = steps 4+5; Task 5 = step 6; Task 6 = step 7; Task 7 = step 8; Task 8 = step 9; Task 9 = steps 10+11; Task 10 = step 12).
- §6 A1-A7 gates → A1 Task 5, A2 Task 6, A3/A4 Task 10 step 1, A4.1 Task 4 step 2, A5 Task 8, A6 Task 9, A7 deferred (documented in Task 10 commit message).
- §7 risks → mitigations distributed across Tasks 2 (sed false-positive spot-check), 3 (purity script semantic edit), 4 (lock-diff), 8 (cwd discipline).
- §8 rollback → not duplicated as a task (single commit; spec §8 covers `git reset --hard HEAD~1 && (cd vnext && bun install)`).

**Placeholder scan:** no TBD / TODO / "fill in later" / "similar to". Every step has either a command or an inline edit description with the exact regex/text.

**Type/name consistency:** `UNSCOPED_VIBE`, `LEGACY_VNEXT`, `/tmp/spec11-typecheck-baseline.txt`, `/tmp/spec11-typecheck-after.txt`, `/tmp/spec11-occurrence-baseline.txt`, `vnext-platform-bun:spec11` used consistently across tasks.

---

## Execution Handoff

Plan complete and saved to `vnext/docs/superpowers/plans/2026-06-25-spec11-namespace-rename.md`.

Per standing directive ("按顺序一路执行到完毕不用等我指令"), proceeding with **Subagent-Driven Development**:
- Fresh implementation subagent per task
- Two-stage review (spec compliance then code quality) after each task
- TodoWrite tracks progress; final reviewer after Task 10
