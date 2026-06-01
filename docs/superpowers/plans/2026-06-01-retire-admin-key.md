# Retire ADMIN_KEY Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `ADMIN_KEY` magic-string credential entirely so the only authenticated principals are logged-in users (session token or their own API key), with admin status driven solely by `ADMIN_EMAILS`.

**Architecture:** Mechanical removal across five files. Local-mode seeding switches from `env.ADMIN_KEY` to a hard-coded `LOCAL_DEV_PASSWORD`. `getServerSecret` becomes strict in CFW (throws if `SERVER_SECRET` unset) and auto-defaults in local. After this lands, the auth middleware understands exactly three credential kinds: session token (`ses_*`), API key (`sk_*`), unauthenticated.

**Tech Stack:** Bun runtime, Elysia HTTP framework, TypeScript, `bun test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-01-retire-admin-key-and-chat-playground-design.md` (Sub-project A).

---

## File Structure

| File | Change |
| --- | --- |
| `src/local.ts` | Add `LOCAL_DEV_PASSWORD` const; seed password from it; programmatic `SERVER_SECRET` default; delete two ADMIN_KEY auth branches; delete `ADMIN_KEY` from `LocalEnv` and env literal; fix startup log |
| `src/index.ts` | Delete two ADMIN_KEY auth branches |
| `src/routes/auth/sessions.ts` | Delete ADMIN_KEY-as-session-token branch |
| `src/lib/redact-shared-view.ts` | `getServerSecret` strict mode (throws on CFW when unset) |
| `src/lib/state.ts` | Remove `ADMIN_KEY?: string` from `Env` |
| `tests/retire-admin-key.test.ts` | New: cover `getServerSecret` strict, sessions endpoint rejects arbitrary string |

---

## Task 1: Add `LOCAL_DEV_PASSWORD` constant and rewrite local seed/log

**Files:**
- Modify: `src/local.ts:189,338-353,632`

- [ ] **Step 1: Add the constant near other top-level local-only constants**

Insert after the `colors` object (around line 60), or alongside the other module constants near line 46:

```ts
// Hard-coded local-dev credentials. Local mode only — never used in CFW build.
const LOCAL_DEV_PASSWORD = "local-dev-admin"
const LOCAL_DEV_SERVER_SECRET = "local-dev-server-secret"
```

- [ ] **Step 2: Default `SERVER_SECRET` programmatically when unset (local only)**

Find the env literal (`src/local.ts:187-197`). Add a `SERVER_SECRET` fallback just before the `env` const is built. Replace:

```ts
const env: LocalEnv = {
  ACCOUNT_TYPE: process.env.ACCOUNT_TYPE,
  ADMIN_KEY: process.env.ADMIN_KEY || "xuangong123!",
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
```

with:

```ts
if (!process.env.SERVER_SECRET) {
  process.env.SERVER_SECRET = LOCAL_DEV_SERVER_SECRET
  console.log("⚠️  SERVER_SECRET unset; using local dev default (dev only)")
}

const env: LocalEnv = {
  ACCOUNT_TYPE: process.env.ACCOUNT_TYPE,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
```

(Removing the `ADMIN_KEY: process.env.ADMIN_KEY || "xuangong123!",` line — the personal password literal goes away.)

- [ ] **Step 3: Replace seed password source**

At `src/local.ts:343`, replace:

```ts
const passwordHash = await hashPassword(env.ADMIN_KEY)
```

with:

```ts
const passwordHash = await hashPassword(LOCAL_DEV_PASSWORD)
```

- [ ] **Step 4: Fix the startup log line**

At `src/local.ts:632`, replace:

```ts
console.log(`👤 Admin login: test@local.dev / ${env.ADMIN_KEY}`)
```

with:

```ts
console.log(`🔑 Local admin login: test@local.dev / ${LOCAL_DEV_PASSWORD} (dev only)`)
```

- [ ] **Step 5: Sanity check — start local server and log in**

Run: `bun run src/local.ts`
Expected: server starts on `http://localhost:41414`; startup banner contains `🔑 Local admin login: test@local.dev / local-dev-admin (dev only)`; no `xuangong123!` anywhere in stdout. Stop with Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add src/local.ts
git commit -m "feat(local): seed admin from LOCAL_DEV_PASSWORD, drop env.ADMIN_KEY usage"
```

---

## Task 2: `getServerSecret` strict mode + test

**Files:**
- Modify: `src/lib/redact-shared-view.ts:56-59`
- Create: `tests/retire-admin-key.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/retire-admin-key.test.ts`:

```ts
import { test, expect, describe } from "bun:test"
import { getServerSecret } from "~/lib/redact-shared-view"

describe("getServerSecret", () => {
  test("returns SERVER_SECRET when set", () => {
    expect(getServerSecret({ SERVER_SECRET: "abc" })).toBe("abc")
  })

  test("throws when SERVER_SECRET unset (CFW shape)", () => {
    expect(() => getServerSecret({})).toThrow("SERVER_SECRET must be set")
  })

  test("ignores ADMIN_KEY entirely (legacy gone)", () => {
    // Old behavior would have fallen back to ADMIN_KEY; new behavior must throw.
    expect(() => getServerSecret({ ADMIN_KEY: "legacy" })).toThrow("SERVER_SECRET must be set")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/retire-admin-key.test.ts`
Expected: 2 of 3 fail (the two `toThrow` cases). Current impl falls back to `ADMIN_KEY` or `"dev-server-secret-change-me"` instead of throwing.

- [ ] **Step 3: Implement strict mode**

Replace `src/lib/redact-shared-view.ts:56-59`:

```ts
/** Read SERVER_SECRET from env or fall back to a deterministic dev value. */
export function getServerSecret(env: Record<string, string | undefined>): string {
  return env.SERVER_SECRET || env.ADMIN_KEY || "dev-server-secret-change-me"
}
```

with:

```ts
/**
 * Read SERVER_SECRET from env. In CFW the variable must be set explicitly;
 * local mode programmatically defaults it before this is ever called
 * (see src/local.ts LOCAL_DEV_SERVER_SECRET fallback).
 */
export function getServerSecret(env: Record<string, string | undefined>): string {
  if (!env.SERVER_SECRET) {
    throw new Error("SERVER_SECRET must be set")
  }
  return env.SERVER_SECRET
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/retire-admin-key.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Run full curated test suite to catch collateral**

Run: `bun test`
Expected: all pass. If any existing test relied on the `ADMIN_KEY` fallback inside `getServerSecret`, update it to set `SERVER_SECRET` explicitly.

- [ ] **Step 6: Commit**

```bash
git add src/lib/redact-shared-view.ts tests/retire-admin-key.test.ts
git commit -m "feat(redact): make getServerSecret strict; require SERVER_SECRET"
```

---

## Task 3: Delete ADMIN_KEY auth branches in `src/index.ts` (CFW)

**Files:**
- Modify: `src/index.ts:274-278,304-311`

- [ ] **Step 1: Delete the `/auth/*` branch**

At `src/index.ts:274-278`, delete these five lines:

```ts
      // Check ADMIN_KEY (legacy)
      const adminKey = env.ADMIN_KEY
      if (adminKey && key === adminKey) {
        return { authKey: key, isAdmin: true, isUser: false, apiKeyId: undefined, userId: undefined, authKind: 'admin' as const }
      }
```

- [ ] **Step 2: Delete the main-path branch**

At `src/index.ts:304-311` (line numbers shift after Step 1), delete these eight lines:

```ts
    // Check ADMIN_KEY - dashboard/management only (legacy)
    const adminKey = env.ADMIN_KEY
    if (adminKey && key === adminKey) {
      if (DASHBOARD_PREFIXES.some((p) => path.startsWith(p))) {
        return { authKey: key, isAdmin: true, isUser: false, apiKeyId: undefined, userId: undefined, authKind: 'admin' as const }
      }
      throw new Error("This key is for dashboard only. Create an API key for API access.")
    }
```

- [ ] **Step 3: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors. (`env.ADMIN_KEY` references are gone; the `ADMIN_KEY?` field on `Env` still exists temporarily — Task 6 removes it.)

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "refactor(cfw): remove ADMIN_KEY branches from auth middleware"
```

---

## Task 4: Delete ADMIN_KEY auth branches in `src/local.ts`

**Files:**
- Modify: `src/local.ts:399-403,429-436`

- [ ] **Step 1: Delete the `/auth/*` branch**

At `src/local.ts:399-403`, delete these five lines:

```ts
      // Check ADMIN_KEY (legacy)
      const adminKey = env.ADMIN_KEY
      if (adminKey && key === adminKey) {
        return { authKey: key, isAdmin: true, isUser: true, apiKeyId: undefined, userId: TEST_ADMIN_USER_ID, authKind: 'admin' as const }
      }
```

- [ ] **Step 2: Delete the main-path branch**

At `src/local.ts:429-436`, delete these eight lines:

```ts
    // Check ADMIN_KEY - dashboard/management only (legacy)
    const adminKey = env.ADMIN_KEY
    if (adminKey && key === adminKey) {
      if (DASHBOARD_PREFIXES.some((p) => path.startsWith(p))) {
        return { authKey: key, isAdmin: true, isUser: true, apiKeyId: undefined, userId: TEST_ADMIN_USER_ID, authKind: 'admin' as const }
      }
      throw new Error("This key is for dashboard only. Create an API key for API access.")
    }
```

- [ ] **Step 3: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Smoke test login still works**

Run: `bun run src/local.ts` in one terminal. In another:

```bash
curl -sX POST http://localhost:41414/auth/email/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@local.dev","password":"local-dev-admin"}' | head -c 300
```

Expected: JSON with `ok: true, isAdmin: true, sessionToken: "ses_..."`. Kill the server.

- [ ] **Step 5: Commit**

```bash
git add src/local.ts
git commit -m "refactor(local): remove ADMIN_KEY branches from auth middleware"
```

---

## Task 5: Delete ADMIN_KEY-as-session branch in `sessions.ts`

**Files:**
- Modify: `src/routes/auth/sessions.ts:27-31`
- Modify: `tests/retire-admin-key.test.ts` (extend)

- [ ] **Step 1: Extend the test**

Append to `tests/retire-admin-key.test.ts`:

```ts
import { Elysia } from "elysia"
import { sessionsRoute } from "~/routes/auth/sessions"

describe("POST /auth/login (sessions route)", () => {
  test("rejects an arbitrary non-session string", async () => {
    const app = new Elysia({ aot: false })
      .derive(() => ({ env: { ADMIN_KEY: "would-have-passed-before" } }))
      .use(sessionsRoute)

    const res = await app.handle(
      new Request("http://localhost/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "would-have-passed-before" }),
      }),
    )
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBeDefined()
  })
})
```

- [ ] **Step 2: Run test — should fail (returns 200 because ADMIN_KEY branch still exists)**

Run: `bun test tests/retire-admin-key.test.ts`
Expected: the new test fails with status 200 (current code accepts the string).

- [ ] **Step 3: Delete the legacy branch**

At `src/routes/auth/sessions.ts:27-31`, delete these five lines:

```ts
    // Check ADMIN_KEY (legacy, kept for backward compat during transition)
    const adminKey = env?.ADMIN_KEY
    if (adminKey && sessionToken === adminKey) {
      return { ok: true, isAdmin: true }
    }
```

- [ ] **Step 4: Run test — should pass**

Run: `bun test tests/retire-admin-key.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/routes/auth/sessions.ts tests/retire-admin-key.test.ts
git commit -m "refactor(sessions): remove ADMIN_KEY-as-session legacy branch"
```

---

## Task 6: Remove `ADMIN_KEY` from `Env` / `LocalEnv` types

**Files:**
- Modify: `src/lib/state.ts:26`
- Modify: `src/local.ts:175-185`

- [ ] **Step 1: Remove from `Env`**

At `src/lib/state.ts:26`, delete the line:

```ts
  ADMIN_KEY?: string
```

- [ ] **Step 2: Remove from `LocalEnv`**

At `src/local.ts:175-185`, delete the line:

```ts
  ADMIN_KEY: string
```

inside the `LocalEnv` interface.

- [ ] **Step 3: Typecheck — last reference cleanup**

Run: `bunx tsc --noEmit`
Expected: no errors. If TS surfaces any remaining `env.ADMIN_KEY` use, delete that reference too.

- [ ] **Step 4: Grep audit**

Run: `grep -rn "ADMIN_KEY" src/ tests/ scripts/`
Expected: no matches except inside this plan path. If matches remain, delete or migrate them in this commit.

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/state.ts src/local.ts
git commit -m "refactor(env): remove ADMIN_KEY field from Env and LocalEnv types"
```

---

## Task 7: End-to-end smoke test

**Files:** (none modified — verification only)

- [ ] **Step 1: Start local server**

Run: `bun run src/local.ts`
Expected stdout includes:
- `⚠️  SERVER_SECRET unset; using local dev default (dev only)` (if `.env` has no SERVER_SECRET)
- `🔑 Local admin login: test@local.dev / local-dev-admin (dev only)`

- [ ] **Step 2: Bearer with old admin-key value must 401**

In another shell:

```bash
curl -i -s http://localhost:41414/api/keys -H 'Authorization: Bearer xuangong123!' | head -3
```

Expected: `HTTP/1.1 401`.

- [ ] **Step 3: Login + session token works**

```bash
SES=$(curl -s -X POST http://localhost:41414/auth/email/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@local.dev","password":"local-dev-admin"}' \
  | grep -oE 'ses_[A-Za-z0-9_-]+' | head -1)
echo "Session: $SES"
curl -i -s "http://localhost:41414/api/keys" -H "Authorization: Bearer $SES" | head -3
```

Expected: second curl returns `HTTP/1.1 200`.

- [ ] **Step 4: Kill server**

Ctrl+C in the server terminal.

- [ ] **Step 5: Final commit (only if Steps 1–4 surfaced any fix; otherwise skip)**

```bash
git status   # expect clean
```

No commit if clean.
