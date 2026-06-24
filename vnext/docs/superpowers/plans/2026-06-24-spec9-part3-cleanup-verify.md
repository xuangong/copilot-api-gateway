# Spec 9 Part 3 — Cleanup & Verify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Spec 9 by sweeping the leftover `provider`-flavored debris that Part 2 could not touch (Dockerfile `COPY` paths, residual `package.json` references), verifying that the final tree has zero references to the old `@vnext-llm/provider` name anywhere on disk, building the platform-bun Docker image with the new layout, and running an A6 byte-identical smoke against a pre-Spec-9 baseline.

**Architecture:** No source code changes. Part 1 stood up `@vnext-gateway/upstream`. Part 2 renamed `packages/provider/` → `packages/provider-llm/` and swept every TS/TSX/JSON consumer. Part 3 patches `apps/platform-bun/Dockerfile` (one COPY line rename + one new COPY line for the new `packages/upstream/` directory), runs the full A1–A6 acceptance battery, and performs the manual A6 smoke. After Part 3 the spec is closed — every name in `@vnext-llm/provider` is gone from disk, every framework concern lives in `@vnext-gateway/upstream`, every LLM concern lives in `@vnext-llm/provider-llm`.

**Tech Stack:** Bun 1.x workspaces, TypeScript, `bun test`, `docker build` (Docker Desktop on macOS), ripgrep for residue scans, `curl` for the smoke probe.

**Working directory:** `/Users/zhangxian/projects/copilot-api-gateway/vnext/`

**Spec reference:** `docs/superpowers/specs/2026-06-24-spec9-provider-split.md` §5 step 4–5, §6 (acceptance criteria A1–A6).

**Branch:** stay on `vNext`. No push, no merge, no CFW deploy (per `spec8_execution_constraints` memory). The Docker build is local only.

**Pre-existing state (assumes Part 1 + Part 2 exit criteria all green):**
- `vnext/packages/upstream/` exists (framework, no LLM imports)
- `vnext/packages/provider-llm/` exists (renamed from `provider/`)
- `vnext/packages/provider/` no longer exists on disk (renamed away by Part 2 `git mv`)
- Zero TS/TSX/JSON references to `@vnext-llm/provider` (bare); 58+ references to `@vnext-llm/provider-llm`
- `bun.lock` reflects the new workspace names

---

## File Structure

### Files modified by Part 3

```
vnext/apps/platform-bun/Dockerfile
  Line 24:  COPY packages/provider/package.json packages/provider/
         →  COPY packages/provider-llm/package.json packages/provider-llm/
  Line N:  + COPY packages/upstream/package.json packages/upstream/
         (inserted just before the provider-llm copy so the framework layer
          stays alphabetically before its business overlay)
```

That is the entire diff. Spec 9 §5 step 5 calls out only these two Dockerfile edits.

### Files NOT touched in Part 3

- No source code (`.ts`, `.tsx`) edits — Part 2 finished the consumer sweep
- No new `package.json` edits — Part 2 already added `@vnext-gateway/upstream` to consumer deps where needed (via Part 1's bridge), and Part 2 renamed the bare `@vnext-llm/provider` dep entries to `@vnext-llm/provider-llm`
- No script changes — `scripts/check-framework-purity.ts` already classifies `@vnext-gateway/upstream` correctly
- No test file changes — `tests/fake-provider.test.ts` was renamed-only by Part 2's `git mv`, the FakeProvider import path already flipped via the sed sweep

### Residue inventory the verification scans look for

| Pattern | Expected hit count after Part 3 | Notes |
|---|---|---|
| `@vnext-llm/provider($\|['"/])` (bare name) | 0 | Already 0 after Part 2; we re-check |
| `packages/provider/` (in `Dockerfile`) | 0 | The single line we patch |
| `packages/provider/` (anywhere else: docs, scripts, CI) | informational | Plan docs (`spec9-*.md`, this file, etc.) legitimately mention the old path in narrative — those are not residue, they are history |

---

## Pre-flight

These checks confirm Part 1 + Part 2 are in the state Part 3 assumes. If any fail, STOP and resolve before continuing — Part 3 only does cleanup.

- [ ] **Step 0.1: Confirm branch + clean tree**

```bash
git branch --show-current
git status --porcelain | head
```
Expected: branch is `vNext`; working tree clean (no unstaged edits left over from Part 2).

- [ ] **Step 0.2: Confirm package layout**

```bash
ls vnext/packages/upstream/src/ 2>&1
ls vnext/packages/provider-llm/src/ 2>&1
ls vnext/packages/provider/ 2>&1 || echo "EXPECTED: provider directory gone"
```
Expected:
- `upstream/src/` has 6 files (`types.ts`, `plugin.ts`, `binding.ts`, `probe.ts`, `errors.ts`, `index.ts`)
- `provider-llm/src/` has 7 files (the six bridge files plus the extracted `fake.ts`)
- `provider/` is absent

- [ ] **Step 0.3: Confirm zero residual bare-name references in source**

```bash
rg -n "@vnext-llm/provider($|['\"/])" vnext/packages vnext/apps -g '*.ts' -g '*.tsx' -g '*.json' && echo "RESIDUE" || echo OK
```
Expected: `OK`. (`rg` exits non-zero with no matches.) If any hit, return to Part 2 and finish the sweep — do not patch it manually here.

- [ ] **Step 0.4: Confirm baseline test suite + purity gate green**

```bash
bun test 2>&1 | tail -3
bun run scripts/check-framework-purity.ts && echo OK
```
Expected: `0 fail` and `OK`. Capture the pass count from the test summary (e.g. `981 pass`); store it as the A1 baseline reference.

- [ ] **Step 0.5: Confirm Docker daemon is available**

```bash
docker info 2>&1 | head -5
```
Expected: prints daemon info (not `Cannot connect to the Docker daemon`). Required for Task 2's image build. If Docker is not running locally, start Docker Desktop before proceeding.

---

## Task 1: Patch `apps/platform-bun/Dockerfile`

**Files:**
- Modify: `vnext/apps/platform-bun/Dockerfile`

Today the per-package manifest section copies one `package.json` per workspace member. Spec 9 added one new member (`packages/upstream`) and renamed one (`packages/provider` → `packages/provider-llm`). Two surgical edits.

- [ ] **Step 1.1: Open the file and locate the per-package COPY block**

The block begins after the comment line `# Per-package manifests for workspace resolution.` and ends before `RUN bun install --frozen-lockfile`. It currently has 16 `COPY` lines, in roughly this order:

```dockerfile
COPY apps/platform-bun/package.json apps/platform-bun/
COPY apps/platform-cloudflare/package.json apps/platform-cloudflare/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/gateway/package.json packages/gateway/
COPY packages/platform/package.json packages/platform/
COPY packages/protocols-llm/package.json packages/protocols-llm/
COPY packages/result/package.json packages/result/
COPY packages/service/package.json packages/service/
COPY packages/provider/package.json packages/provider/                     ← rename
COPY packages/provider-azure/package.json packages/provider-azure/
COPY packages/provider-copilot/package.json packages/provider-copilot/
COPY packages/provider-custom/package.json packages/provider-custom/
COPY packages/provider-sdf/package.json packages/provider-sdf/
COPY packages/responses-store/package.json packages/responses-store/
COPY packages/cache/package.json packages/cache/
COPY packages/http/package.json packages/http/
COPY packages/translate/package.json packages/translate/
```

- [ ] **Step 1.2: Edit — rename the provider COPY to provider-llm**

Replace this single line:
```dockerfile
COPY packages/provider/package.json packages/provider/
```
With:
```dockerfile
COPY packages/provider-llm/package.json packages/provider-llm/
```

- [ ] **Step 1.3: Edit — insert the new upstream COPY**

Immediately BEFORE the `packages/provider-llm` COPY line, insert:
```dockerfile
COPY packages/upstream/package.json packages/upstream/
```

The framework layer is copied before the business overlay that depends on it. Bun's workspace resolver does not care about COPY order at install time (it scans all manifests after every copy lands), but the alphabetical-by-layer order is friendlier to future readers.

The relevant block after both edits:

```dockerfile
COPY packages/protocols-llm/package.json packages/protocols-llm/
COPY packages/result/package.json packages/result/
COPY packages/service/package.json packages/service/
COPY packages/upstream/package.json packages/upstream/
COPY packages/provider-llm/package.json packages/provider-llm/
COPY packages/provider-azure/package.json packages/provider-azure/
COPY packages/provider-copilot/package.json packages/provider-copilot/
COPY packages/provider-custom/package.json packages/provider-custom/
COPY packages/provider-sdf/package.json packages/provider-sdf/
```

- [ ] **Step 1.4: Verify the Dockerfile has the right shape**

```bash
rg -n 'packages/(upstream|provider|provider-llm|provider-azure|provider-copilot|provider-custom|provider-sdf)/package.json' vnext/apps/platform-bun/Dockerfile
```
Expected: 7 hits, no bare `packages/provider/package.json` line. Specifically:
- one `packages/upstream/package.json` line (new)
- one `packages/provider-llm/package.json` line (renamed from `packages/provider`)
- four `packages/provider-{azure,copilot,custom,sdf}/package.json` lines (unchanged)

Negative check:
```bash
rg -n '^COPY packages/provider/package\.json' vnext/apps/platform-bun/Dockerfile && echo "STALE" || echo OK
```
Expected: `OK`.

- [ ] **Step 1.5: Commit the Dockerfile edit**

```bash
git add vnext/apps/platform-bun/Dockerfile
git commit -m "build(vnext/platform-bun): update Dockerfile COPY paths for spec 9

Renames the per-package manifest COPY entry for the provider package
from packages/provider → packages/provider-llm, and inserts a new
COPY entry for packages/upstream so the @vnext-gateway/upstream
framework workspace is present at \`bun install --frozen-lockfile\`
time. Spec 9 Part 3 step 5.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

---

## Task 2: Build the platform-bun image (acceptance A5)

**Files:** none modified. This task is a verification gate.

- [ ] **Step 2.1: Build with the updated Dockerfile**

From the repo root:
```bash
docker build -f vnext/apps/platform-bun/Dockerfile vnext/ -t copilot-api-gateway:spec9-part3 2>&1 | tail -40
```
Expected: build succeeds; final line shows the image tag. The two failure modes to watch:

1. **`COPY failed: no such file or directory` for `packages/upstream/package.json`** — Step 1.3 was skipped or mis-applied. Re-apply, re-build.
2. **`bun install --frozen-lockfile` fails with workspace-not-found** — `bun.lock` is stale. Run `bun install` from `vnext/`, commit the regenerated lockfile, re-build.

If you see TypeScript errors during `bun run build:ui`, they are not Spec-9-induced (the dashboard build does not consume `@vnext-llm/provider-llm`). Check whether the same error reproduces on the prior commit; if yes, it is a pre-existing baseline.

- [ ] **Step 2.2: Smoke-run the image briefly to confirm the binary starts**

```bash
docker run --rm --name spec9-smoke -d -p 41416:41415 \
  -e VNEXT_DB_PATH=/data/vnext.sqlite \
  copilot-api-gateway:spec9-part3
sleep 3
docker logs spec9-smoke 2>&1 | tail -20
curl -sf http://localhost:41416/health || echo "HEALTH ENDPOINT MISSING"
docker stop spec9-smoke
```
Expected: container starts (logs show server bound to port 41415); the `curl` either returns 200 or `HEALTH ENDPOINT MISSING` (the latter is fine — Spec 9 does not require a health endpoint, this is just a "process didn't crash" check). Any uncaught exception in the logs is a regression — investigate before continuing.

- [ ] **Step 2.3: Clean up the smoke image**

```bash
docker rmi copilot-api-gateway:spec9-part3 || true
```
Free disk; the build is reproducible from `git`. No commit — this task is verification only.

---

## Task 3: A1–A6 acceptance battery

**Files:** none modified. This task runs every Spec 9 §6 acceptance check end-to-end on the final tree.

- [ ] **Step 3.1: A1 — `bun test` green**

```bash
bun test 2>&1 | tail -3
```
Expected: same pass count as Pre-flight 0.4 baseline, `0 fail`. If a test newly fails, the most likely cause is a subtle interface drift between the old `ModelProvider` and the new `LlmModelProvider` shape that the sed missed inside a string literal or template — search the failing test's stack frames for the symbol it complains about.

- [ ] **Step 3.2: A2 — per-package typecheck across the full graph**

```bash
for p in upstream provider-llm provider-copilot provider-azure provider-custom provider-sdf gateway; do
  echo "=== $p ===" && (cd vnext/packages/$p && bun run typecheck) || { echo "FAIL: $p"; exit 1; }
done
for app in platform-bun platform-cloudflare dashboard; do
  echo "=== $app ===" && (cd vnext/apps/$app && bun run typecheck) || { echo "FAIL: $app"; exit 1; }
done
```
Expected: each exits 0 (or matches the pre-existing Spec 7 §8.1 / Spec 8 §A2 baseline error set — `vnext/docs/superpowers/specs/2026-06-24-spec8-protocols-split.md` §A2 enumerates the allowable carry-over errors). No NEW error.

- [ ] **Step 3.3: A3 — framework purity gate + manual spot-check**

```bash
bun run scripts/check-framework-purity.ts && echo OK
rg -n 'ModelPricing|EndpointKey|UpstreamKind|ModelEndpoints|Invocation|RequestContext|@vnext-llm/' vnext/packages/upstream/src/ && echo "VIOLATION" || echo OK
```
Expected: both print `OK`. The script's automated gate catches `@vnext-llm/*` imports inside `@vnext-gateway/*` packages; the manual `rg` doubles up by catching string-level mentions of the seven business symbols Spec 9 §3.6 forbids in the framework surface.

- [ ] **Step 3.4: A4 — zero bare `@vnext-llm/provider` references**

```bash
rg -n "@vnext-llm/provider($|['\"/])" vnext/packages vnext/apps -g '*.ts' -g '*.tsx' -g '*.json' && echo "RESIDUE" || echo OK
```
Expected: `OK`. The `($|['"/])` alternation matches end-of-line, single/double quote, or `/`, which together cover every legitimate consumer surface (`from '@vnext-llm/provider'`, `from "@vnext-llm/provider"`, `from '@vnext-llm/provider/types'`, and `package.json` `"@vnext-llm/provider": "workspace:*"`). The `provider-llm`, `provider-azure`, `provider-copilot`, `provider-custom`, `provider-sdf` names all have `-` after `provider`, which is excluded by the alternation — so they do not hit. Avoids ripgrep lookaround so the default `rg` build (no `-P`) works.

Additionally cross-check the lockfile:
```bash
rg '"@vnext-llm/provider"' vnext/bun.lock && echo "LOCKFILE STALE" || echo OK
```
Expected: `OK`. If the lockfile still mentions the bare name, run `bun install` from `vnext/` and recommit; lockfile drift is the most common Part-3 surprise.

- [ ] **Step 3.5: A5 — Docker build green (already done in Task 2)**

Re-confirm with a `--no-cache` rebuild to catch any layer-cache masking:
```bash
docker build --no-cache -f vnext/apps/platform-bun/Dockerfile vnext/ -t copilot-api-gateway:spec9-final 2>&1 | tail -10
```
Expected: build succeeds end-to-end. The `--no-cache` flag forces every COPY + RUN to re-execute, so this catches the case where Task 2's cached image masked a stale layer.

Clean up:
```bash
docker rmi copilot-api-gateway:spec9-final || true
```

- [ ] **Step 3.6: A6 — manual byte-identical smoke**

This is a human-verified step. Pick one representative call per surface and compare against a pre-Spec-9 baseline. The pre-Spec-9 baseline is the commit immediately before the Part 1 commit (`cc7d582 docs(vnext/spec9): add Part 1 Foundation implementation plan`'s parent — find it with `git log --oneline -n 5 cc7d582`).

For each surface, capture the response body from BOTH commits using the same input and compare via `diff`. The four surfaces:

| Surface | Endpoint | Sample input |
|---|---|---|
| OpenAI chat-completions | `POST /v1/chat/completions` | `{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}` |
| Anthropic messages | `POST /v1/messages` | `{"model":"claude-3-5-sonnet-latest","max_tokens":32,"messages":[{"role":"user","content":"hi"}]}` |
| OpenAI Responses | `POST /v1/responses` | `{"model":"gpt-4o-mini","input":"hi"}` |
| Gemini generateContent | `POST /v1beta/models/gemini-2.0-flash:generateContent` | `{"contents":[{"parts":[{"text":"hi"}]}]}` |

Procedure (run twice — once on `vNext` HEAD, once on the pre-Part-1 parent):

```bash
# Start the server with FakeProvider routing so the smoke is deterministic.
# (If your local config does not have a fake route, use a stub model id that
# routes to the actual fake provider per packages/provider-llm/src/fake.ts.)
bun run local &
SERVER_PID=$!
sleep 2

# Capture
for path in /v1/chat/completions /v1/messages /v1/responses /v1beta/models/gemini-2.0-flash:generateContent; do
  curl -sf -X POST "http://localhost:41415$path" \
    -H 'authorization: Bearer fake' \
    -H 'content-type: application/json' \
    -d '{...payload...}' \
    > "/tmp/spec9-smoke-$(echo $path | tr / _).json"
done

kill $SERVER_PID
```

Then `git switch --detach <pre-part-1-sha>`, repeat the capture into `/tmp/spec9-smoke-baseline-*.json`, switch back to `vNext`, and:

```bash
for surface in chat_completions messages responses generateContent; do
  diff "/tmp/spec9-smoke-baseline-${surface}.json" "/tmp/spec9-smoke-vnext-${surface}.json" \
    && echo "$surface: IDENTICAL" \
    || echo "$surface: DIVERGED — investigate"
done
```
Expected: all four print `IDENTICAL`. The only fields that may legitimately drift between runs are wall-clock timestamps and request IDs — if a diff is limited to those, treat as IDENTICAL. If response bodies differ in any business field (model, content, finish_reason, usage, tool_calls), investigate before declaring Spec 9 done.

If you cannot route through the live providers safely (token expiry, network constraints), substitute FakeProvider as the routing target — Spec 9 made zero changes to FakeProvider behavior, so its output must be byte-identical between the two commits.

- [ ] **Step 3.7: Capture the acceptance results**

Append a brief note to `vnext/docs/superpowers/specs/2026-06-24-spec9-provider-split.md` under a new `## 9. Acceptance log` heading, with one line per criterion and a timestamp. Example:

```markdown
## 9. Acceptance log

| ID | Result | Verified on |
|---|---|---|
| A1 | ✅ `bun test` 981 pass / 0 fail | 2026-06-24 |
| A2 | ✅ per-package typecheck green, no new errors | 2026-06-24 |
| A3 | ✅ purity gate + manual rg both clean | 2026-06-24 |
| A4 | ✅ zero bare `@vnext-llm/provider` references | 2026-06-24 |
| A5 | ✅ `docker build` succeeds (cached + `--no-cache`) | 2026-06-24 |
| A6 | ✅ four-surface smoke byte-identical to pre-Spec-9 baseline | 2026-06-24 |
```

Substitute the actual date and pass count.

- [ ] **Step 3.8: Commit the acceptance log**

```bash
git add vnext/docs/superpowers/specs/2026-06-24-spec9-provider-split.md
git commit -m "docs(vnext/spec9): record A1–A6 acceptance results

Marks Spec 9 (provider split) complete: framework upstream package
@vnext-gateway/upstream stood up, business overlay @vnext-llm/provider-llm
hosts all LLM-specific contracts, every old @vnext-llm/provider reference
removed from disk, platform-bun image builds clean, four-surface smoke
byte-identical to pre-Spec-9 baseline.

Spec 9 Part 3 step 6.

Generated with [Claude Code](https://claude.ai/code)
via [Happy](https://happy.engineering)

Co-Authored-By: Claude <noreply@anthropic.com>
Co-Authored-By: Happy <yesreply@happy.engineering>"
```

---

## Exit criteria for Part 3 (and for Spec 9 as a whole)

All must hold for Spec 9 to be considered complete:

| ID | Check | Command |
|---|---|---|
| P3-A1 | Dockerfile patched (provider-llm + upstream COPY lines present, bare provider COPY removed) | `rg -n 'packages/(upstream\|provider-llm)/package\.json' vnext/apps/platform-bun/Dockerfile \| wc -l` returns 2; `rg -n '^COPY packages/provider/package\.json' vnext/apps/platform-bun/Dockerfile` exits 1 |
| P3-A2 | `docker build -f vnext/apps/platform-bun/Dockerfile vnext/` succeeds | manual; final `docker build` line shows a successful tag |
| P3-A3 | `--no-cache` Docker rebuild succeeds (no cached masking) | manual; `docker build --no-cache ...` succeeds |
| P3-A4 | A1 — `bun test` baseline pass / 0 fail | `bun test 2>&1 \| tail -3` |
| P3-A5 | A2 — per-package + per-app typecheck green (no new errors) | the loop in Step 3.2 |
| P3-A6 | A3 — purity gate green; `@vnext-gateway/upstream/src/` LLM-free | the two commands in Step 3.3 |
| P3-A7 | A4 — zero bare `@vnext-llm/provider` references on disk OR in `bun.lock` | the two commands in Step 3.4 |
| P3-A8 | A6 — four-surface smoke byte-identical to pre-Spec-9 baseline | the procedure in Step 3.6 |
| P3-A9 | Acceptance log committed to the spec doc | `git log --oneline vnext/docs/superpowers/specs/2026-06-24-spec9-provider-split.md \| head -3` shows the Step 3.8 commit |

If every row above is ✅, hand off to the next roadmap item (Spec 10 / Roadmap §3 step 5 — `@vnext-llm/gateway` runtime vs application split). Otherwise fix the failing row before declaring Spec 9 done; do not advance the roadmap with red acceptance.
