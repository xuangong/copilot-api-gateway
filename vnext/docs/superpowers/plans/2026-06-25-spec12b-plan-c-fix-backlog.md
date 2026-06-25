# Spec 12b Plan C — Fix Backlog Closure (parity 0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Drive `2026-06-25-spec12b-fix-backlog.md` from N → 0 by clustering gaps, implementing each fix in vNext, and re-running the 12b harness after every cluster until `behavior-gap + route-missing = 0` (Spec 12b gate A6).

**Architecture:**
- Plan B produced `fix-backlog.md` grouped into clusters keyed by `<label>:<endpoint segment>` (e.g. `route-missing:keys`, `behavior-gap:upstreams`, `behavior-gap:observability-shares`).
- This plan executes one cluster per Task. Each Task = subagent dispatch with cluster definition + acceptance criteria.
- After every cluster commit, harness reruns (`bun control-plane-audit.ts`) and `fix-backlog.md` is regenerated. New baseline is committed before next cluster begins.
- We do NOT modify root `src/` — only vNext (`vnext/packages/gateway/src/control-plane/**`).

**Tech Stack:** Bun, TypeScript, Hono/Elysia routes in vNext gateway, SqliteRepo / D1Repo for storage. No new deps.

**Pre-req:** Plan B merged (`control-plane-audit.ts` + 50 fixtures + initial `fix-backlog.md` committed).

**Scope guard:** Plan C does NOT touch data-plane, dashboard SPA, auth flow, or merge to main. Local docker only.

---

## Task 9: Cluster triage & plan freeze

**Goal:** Read the freshly-produced `fix-backlog.md`, classify each cluster as **port-from-root** (route-missing) vs **fix-shape** (behavior-gap), and assign cluster IDs C1, C2, ….

**Files:**
- Modify: `vnext/docs/superpowers/research/2026-06-25-spec12b-fix-backlog.md` (add a "Cluster Index" section at top)

- [ ] **Step 1: Re-read fix-backlog**

```bash
cat vnext/docs/superpowers/research/2026-06-25-spec12b-fix-backlog.md
```

Note total gap count + every distinct cluster heading.

- [ ] **Step 2: Verify each cluster against root code**

For every cluster, locate the root implementation and confirm the gap is real (NOT a fixture bug):

```bash
# example for cluster route-missing:observability-shares
grep -rn "observability-shares" src/routes/ vnext/packages/gateway/src/control-plane/
```

If the gap turns out to be a fixture / harness issue, downgrade it to a "fixture-fix" sub-task instead of a code-port.

- [ ] **Step 3: Annotate backlog with cluster IDs**

Prepend a section to `fix-backlog.md`:

```markdown
## Cluster Index (Plan C tasks)

| ID | Cluster | Kind | Endpoints | Task |
|----|---------|------|-----------|------|
| C1 | route-missing:<seg> | port-from-root | … | Task 10 |
| C2 | behavior-gap:<seg> | fix-shape | … | Task 11 |
| … | … | … | … | … |

Total open: <N>
```

- [ ] **Step 4: Commit triage**

```bash
git add vnext/docs/superpowers/research/2026-06-25-spec12b-fix-backlog.md
git commit -m "docs(vnext/spec12b-T9): cluster triage — N clusters identified"
```

---

## Task 10..K: Per-cluster fix loop (template)

> Each cluster gets one Task. Below is the template; instantiate it once per cluster.

**Template for Cluster Cn:**

**Files:** (filled in per cluster)
- Modify: `vnext/packages/gateway/src/control-plane/<family>/routes.ts`
- Modify: `vnext/packages/gateway/src/control-plane/<family>/handlers.ts` (or service module)
- Possibly create: `vnext/packages/gateway/src/control-plane/<family>/<new>.ts` (only for route-missing clusters that need new modules)
- Tests to add: `vnext/packages/gateway/src/control-plane/<family>/*.test.ts` (unit tests for new handler behavior, NOT just relying on harness)

**Reference for behavior:** root `src/routes/<family>.ts` is the canonical source. Match status codes, body shape, error format, and validation rules to root.

- [ ] **Step 1: Locate the root behavior**

```bash
# example: api-keys assign endpoint
sed -n '450,500p' src/routes/api-keys.ts
```

Copy the exact validation order, error message strings, response field names. Do NOT improvise.

- [ ] **Step 2: Find the vNext gap**

```bash
sed -n '...,...p' vnext/packages/gateway/src/control-plane/<family>/routes.ts
```

Identify either (a) missing route registration or (b) divergent body shape / status / validation.

- [ ] **Step 3: Write failing unit test**

```ts
// vnext/packages/gateway/src/control-plane/<family>/<new>.test.ts
import { test, expect } from 'bun:test'
// minimal in-memory repo setup; assert the exact response shape root returns
test('<behavior> matches root parity', async () => {
  // ... arrange ...
  const res = await handler(req)
  expect(res.status).toBe(<root status>)
  expect(await res.json()).toMatchObject({ /* root shape */ })
})
```

- [ ] **Step 4: Run test, expect FAIL**

```bash
cd vnext && bun test packages/gateway/src/control-plane/<family>/<new>.test.ts
```

- [ ] **Step 5: Implement minimal fix in vNext**

Touch ONLY the files needed for this cluster. Match root's:
- Status codes (incl. 400 vs 404 vs 422 nuance)
- Error body shape (root uses `{ error: { code, message } }` in some routes, `{ message: '...' }` in others — copy verbatim)
- Field names (e.g. `key` vs `secret` — root uses `key`)
- Validation order (rejecting unknown ownerId BEFORE checking name, etc.)

- [ ] **Step 6: Re-run unit test, expect PASS**

- [ ] **Step 7: Re-run harness (live)**

```bash
source /tmp/parity-12b-env.sh
bun vnext/scripts/parity/control-plane-audit.ts
```

Expected: report shows this cluster's fixtures now labelled `parity` (or `cosmetic-diff`); no NEW gaps appeared in other clusters (regression check).

- [ ] **Step 8: Commit cluster fix**

```bash
git add vnext/packages/gateway/src/control-plane/<family>/ \
        vnext/docs/superpowers/research/2026-06-25-spec12b-parity-report.md \
        vnext/docs/superpowers/research/2026-06-25-spec12b-fix-backlog.md
git commit -m "fix(vnext/spec12b-C<n>): <one-line cluster summary>"
```

The regenerated report + backlog ride with the commit so reviewers see N drop per commit.

- [ ] **Step 9: Stop if A6 reached**

```bash
grep -E '^- (behavior-gap|route-missing):' vnext/docs/superpowers/research/2026-06-25-spec12b-parity-report.md
```

If both lines show `: 0` → jump to Task L (closure). Otherwise loop to next cluster.

---

## Task L: Final closure

- [ ] **Step 1: Final harness run + report freeze**

```bash
bun vnext/scripts/parity/control-plane-audit.ts
```

Expected: summary `behavior-gap: 0`, `route-missing: 0`. `cosmetic-diff` may be nonzero (allowed).

- [ ] **Step 2: Update spec doc with final count**

Edit `vnext/docs/superpowers/specs/2026-06-25-spec12b-control-plane-parity-audit.md` §6 (Acceptance gates) — add a final-state line at bottom:

```markdown
**Final state (YYYY-MM-DD):** parity=<N>, cosmetic-diff=<N>, behavior-gap=0, route-missing=0. Closes A6.
```

- [ ] **Step 3: Commit closure**

```bash
git add vnext/docs/superpowers/specs/2026-06-25-spec12b-control-plane-parity-audit.md \
        vnext/docs/superpowers/research/2026-06-25-spec12b-parity-report.md \
        vnext/docs/superpowers/research/2026-06-25-spec12b-fix-backlog.md
git commit -m "docs(vnext/spec12b): parity 0 — control-plane closure"
```

- [ ] **Step 4: Push vNext (NO merge to main)**

```bash
git push origin vNext
```

Confirm in remote that the branch is up-to-date. **Do not open or merge a PR to main** (Spec 12b §1 explicit non-goal).

---

## Acceptance gates (Plan C)

| ID | Gate | Step |
|----|------|------|
| C0 | Cluster triage committed | T9.Step4 |
| C-per | Each cluster: unit test green + harness shows that cluster's fixtures `parity` | Tn.Step6–7 |
| C-noreg | Each cluster commit shows monotonic gap decrease (no new gaps elsewhere) | Tn.Step7 |
| C-final | `behavior-gap=0` and `route-missing=0` in final report | TL.Step1 |
| C-commit | Spec doc updated with final-state line; vNext pushed | TL.Step3–4 |

This matches Spec 12b §6 A6 (allow `cosmetic-diff`, forbid `behavior-gap` and `route-missing`).

---

## Common cluster recipes

These accelerate per-cluster work. Apply when matching.

### Recipe R1: Missing route mount

**Symptom:** `route-missing` cluster, all endpoints share same `/api/<seg>` prefix.

**Fix shape:**
```ts
// vnext/packages/gateway/src/control-plane/routes.ts
import { <family>Routes } from './<family>/routes'
api.use(<family>Routes)
```

### Recipe R2: Response field name mismatch (`secret` vs `key`)

**Symptom:** `behavior-gap` at `$.key` or `$.secret`.

**Fix shape:** match root verbatim — root `src/routes/api-keys.ts:60` returns `{ key: row.key }` not `secret`. Search vnext for the wrong name and rename. Add ignore-key to `CONTROL_PLANE_RULES` only if both sides agree the field is volatile (e.g. hash); do NOT widen ignores to mask real divergence.

### Recipe R3: Error body shape divergence

**Symptom:** 4xx parity in status but `behavior-gap` in body.

**Fix shape:** root uses `{ error: { code: 'INVALID_OWNER', message: '...' } }` for most validation errors; vnext may use `{ message: '...' }`. Pull the exact shape from root for the same endpoint and replicate.

### Recipe R4: Validation order divergence

**Symptom:** Different status (400 vs 404) for the same invalid input.

**Fix shape:** match root's order of checks. E.g. root checks "key exists" before "user has permission", returning 404 not 403 for unknown key. Re-order vnext guards.

### Recipe R5: Self-action guard missing

**Symptom:** `assign-key-invalid` or `create-share-invalid` fixture expects 400 on self-target but vnext returns 200.

**Fix shape:** add the guard root has — e.g. `if (userId === apiKeyRow.ownerId) return badRequest('cannot assign to self')`.

---

## Stop conditions

- After 6 hours of continuous cluster work without `behavior-gap+route-missing` dropping → pause, write `12b-stuck.md` summarizing remaining clusters and why progress stalled, and ask human.
- If any fix requires a schema migration → escalate; do NOT add migrations under this plan.
- If a cluster cannot be fixed because root behavior is itself buggy → mark cluster `wontfix` in backlog, document the root bug, leave fixture as `behavior-gap` and add an explicit `KNOWN_DEFECTS` allowlist in the harness (separate small commit) so A6 still closes.
