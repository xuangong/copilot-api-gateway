# Admin GitHub-Account Copilot Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins see Copilot quota for every GitHub account already listed in the admin Users panel, without leaving the page.

**Architecture:** One admin-only `GET /api/admin/copilot-quota/:githubUserId` endpoint that wraps the existing `https://api.github.com/copilot_internal/user` upstream call but scoped to a target stored account. Frontend fans out one request per `gh.id` after `loadAdminUsers` returns and renders a small chip beside each `@login`.

**Tech Stack:** Bun + Elysia + bun:sqlite (in-memory for tests) + Alpine.js dashboard.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `tests/admin-copilot-quota.test.ts` | Backend tests for new endpoint | Create |
| `src/routes/dashboard.ts` | Add new admin route | Modify |
| `src/ui/i18n.ts` | Add 2 i18n keys (en + zh) | Modify |
| `src/ui/dashboard/client.ts` | State, fan-out fetch, chip helper | Modify |
| `src/ui/dashboard/tabs.ts` | Render chip beside `@login` | Modify |

---

### Task 1: Failing tests for `/api/admin/copilot-quota/:githubUserId`

**Files:**
- Create: `tests/admin-copilot-quota.test.ts`

- [ ] **Step 1: Create the test file**

```ts
/**
 * TDD red-phase tests for admin per-GitHub-account Copilot quota endpoint.
 * Will fail until the route is added in Task 2.
 */
import { test, expect, beforeEach, afterEach } from "bun:test"
import { Elysia } from "elysia"
import { Database } from "bun:sqlite"
import { SqliteRepo } from "../src/repo/sqlite"
import { setRepoForTest } from "../src/repo"
import { dashboardRoute } from "../src/routes/dashboard"

let app: Elysia
const realFetch = globalThis.fetch
let fetchCalls: Array<{ url: string; init?: RequestInit }> = []
let mockResponses: Array<{ url: RegExp; response: Response | (() => Response | Promise<Response>) }> = []

function installMockFetch() {
  fetchCalls = []
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url
    fetchCalls.push({ url, init })
    for (const m of mockResponses) {
      if (m.url.test(url)) {
        return typeof m.response === "function" ? await m.response() : m.response
      }
    }
    throw new Error("Unmocked fetch: " + url)
  }) as typeof fetch
}

beforeEach(async () => {
  installMockFetch()
  mockResponses = []

  const db = new Database(":memory:")
  const repo = new SqliteRepo(db)
  setRepoForTest(repo as any)

  // Seed admin owner + one user with a GitHub account
  await repo.users.create({
    id: "u-admin",
    name: "Admin",
    email: "admin@example.com",
    createdAt: new Date().toISOString(),
    disabled: false,
  })
  await repo.users.create({
    id: "u-bob",
    name: "Bob",
    email: "bob@example.com",
    createdAt: new Date().toISOString(),
    disabled: false,
  })
  await repo.github.saveAccount(424242, {
    token: "gho_bob_token",
    accountType: "individual",
    user: { id: 424242, login: "bob-gh", name: "Bob GH", avatar_url: "" },
    ownerId: "u-bob",
  })

  app = new Elysia().use(
    new Elysia()
      .derive(({ request }) => {
        const raw = request.headers.get("x-test-auth")
        return raw ? JSON.parse(raw) : {}
      })
      .use(dashboardRoute)
  )
})

afterEach(() => {
  globalThis.fetch = realFetch
})

const adminAuth = JSON.stringify({ isAdmin: true, userId: "u-admin" })
const userAuth = JSON.stringify({ isAdmin: false, userId: "u-bob" })

test("admin + valid github user id -> 200 with upstream JSON", async () => {
  mockResponses.push({
    url: /api\.github\.com\/copilot_internal\/user/,
    response: new Response(JSON.stringify({ quota_snapshots: { premium_interactions: { entitlement: 1500, remaining: 1068, percent_remaining: 71.2, unlimited: false } } }), { status: 200, headers: { "content-type": "application/json" } }),
  })

  const res = await app.handle(new Request("http://localhost/api/admin/copilot-quota/424242", {
    headers: { "x-test-auth": adminAuth },
  }))
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.quota_snapshots.premium_interactions.entitlement).toBe(1500)
  expect(fetchCalls.length).toBe(1)
  expect(fetchCalls[0].url).toContain("copilot_internal/user")
})

test("non-admin -> 403", async () => {
  const res = await app.handle(new Request("http://localhost/api/admin/copilot-quota/424242", {
    headers: { "x-test-auth": userAuth },
  }))
  expect(res.status).toBe(403)
  const body = await res.json()
  expect(body.error).toBe("Admin only")
  expect(fetchCalls.length).toBe(0)
})

test("admin + unknown github user id -> 404", async () => {
  const res = await app.handle(new Request("http://localhost/api/admin/copilot-quota/999999", {
    headers: { "x-test-auth": adminAuth },
  }))
  expect(res.status).toBe(404)
  const body = await res.json()
  expect(body.error).toBe("GitHub account not found")
  expect(fetchCalls.length).toBe(0)
})

test("upstream 401 -> passthrough 401 with descriptive error", async () => {
  mockResponses.push({
    url: /api\.github\.com\/copilot_internal\/user/,
    response: new Response("token expired", { status: 401 }),
  })
  const res = await app.handle(new Request("http://localhost/api/admin/copilot-quota/424242", {
    headers: { "x-test-auth": adminAuth },
  }))
  expect(res.status).toBe(401)
  const body = await res.json()
  expect(body.error).toContain("GitHub API error: 401")
})

test("fetch throws -> 502", async () => {
  mockResponses.push({
    url: /api\.github\.com\/copilot_internal\/user/,
    response: () => { throw new Error("network down") },
  })
  const res = await app.handle(new Request("http://localhost/api/admin/copilot-quota/424242", {
    headers: { "x-test-auth": adminAuth },
  }))
  expect(res.status).toBe(502)
  const body = await res.json()
  expect(body.error).toContain("network down")
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test tests/admin-copilot-quota.test.ts`
Expected: All 5 tests FAIL (route returns 404 because `/api/admin/copilot-quota/:id` is not registered).

- [ ] **Step 3: Commit the red phase**

```bash
git add tests/admin-copilot-quota.test.ts
git commit -m "test: red-phase tests for admin per-account Copilot quota"
```

---

### Task 2: Implement `/api/admin/copilot-quota/:githubUserId`

**Files:**
- Modify: `src/routes/dashboard.ts` (add new route between existing `/copilot-quota` and `/token-usage` handlers)

- [ ] **Step 1: Add the route handler**

Open `src/routes/dashboard.ts`. Locate the existing `.get("/copilot-quota", ...)` handler that ends with its closing `})`. Immediately after that closing `})` and before `.get("/token-usage", ...)`, insert:

```ts
  // GET /api/admin/copilot-quota/:githubUserId - admin: fetch Copilot quota for a specific GitHub account
  .get("/admin/copilot-quota/:githubUserId", async (ctx) => {
    const { isAdmin } = ctx as unknown as AuthCtx
    if (!isAdmin) {
      return new Response(JSON.stringify({ error: "Admin only" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    }

    const targetId = String((ctx.params as { githubUserId: string }).githubUserId)
    const repo = getRepo()
    const accounts = await repo.github.listAccounts()
    const account = accounts.find(a => String(a.user.id) === targetId)
    if (!account) {
      return new Response(JSON.stringify({ error: "GitHub account not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    }

    try {
      const resp = await fetch("https://api.github.com/copilot_internal/user", {
        headers: createGithubHeaders(account.token),
      })

      if (!resp.ok) {
        const text = await resp.text()
        return new Response(JSON.stringify({ error: `GitHub API error: ${resp.status} ${text}` }), {
          status: resp.status,
          headers: { "Content-Type": "application/json" },
        })
      }

      return resp.json()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      return new Response(JSON.stringify({ error: msg }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      })
    }
  })
```

(`AuthCtx`, `getRepo`, and `createGithubHeaders` are already imported at the top of the file. Do not re-import.)

- [ ] **Step 2: Run tests, verify they pass**

Run: `bun test tests/admin-copilot-quota.test.ts`
Expected: 5 pass / 0 fail.

- [ ] **Step 3: Commit**

```bash
git add src/routes/dashboard.ts
git commit -m "feat(api): admin endpoint to view per-account Copilot quota"
```

---

### Task 3: Add i18n keys

**Files:**
- Modify: `src/ui/i18n.ts`

- [ ] **Step 1: Add English keys**

Find the line in the `en` block that reads `"dash.unshareToast": "Unshared",` (around line 148). Immediately after the `dash.sharedByOwner` line that follows it, add two new lines so the cluster looks like:

```ts
      "dash.unshareToast": "Unshared",
      "dash.unshareErrGeneric": "Failed to unshare",
      "dash.sharedByOwner": "Shared with you by",
      "dash.copilotQuota": "Copilot quota",
      "dash.quotaLoadFailed": "Failed to load quota",
```

- [ ] **Step 2: Add Chinese keys**

Find the corresponding cluster in the `zh` block (around line 463) and update it the same way:

```ts
      "dash.unshareToast": "已取消分享",
      "dash.unshareErrGeneric": "取消分享失败",
      "dash.sharedByOwner": "由该用户分享给你",
      "dash.copilotQuota": "Copilot 配额",
      "dash.quotaLoadFailed": "加载配额失败",
```

- [ ] **Step 3: Sanity check (no test, just type-check via build)**

Run: `bun run build 2>&1 | head -20` (or `bun --print "1"` if no build script — i18n is plain object literals, syntax errors would crash on require).
Expected: No syntax error from `src/ui/i18n.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/ui/i18n.ts
git commit -m "i18n(dashboard): admin per-account Copilot quota strings"
```

---

### Task 4: Frontend state + fan-out fetch

**Files:**
- Modify: `src/ui/dashboard/client.ts`

- [ ] **Step 1: Locate the Alpine state object**

Open `src/ui/dashboard/client.ts`. Find the existing reactive state declaration that contains `adminUsers: []`, `adminUsersLoading: false`. Add two new fields immediately after `adminUsersLoading: false,`:

```js
          adminUsers: [],
          adminUsersLoading: false,
          githubQuotas: {},
          githubQuotaInflight: 0,
```

(`githubQuotas` keys are GitHub user ids; values are `{ loading, error, data }`. `githubQuotaInflight` is a small counter useful for tests / future spinners — keep it for now.)

- [ ] **Step 2: Add `loadGithubQuota` method**

Find the existing `async loadAdminUsers()` method. After its closing `},`, insert a new method:

```js
          async loadGithubQuota(id) {
            if (id == null) return
            this.githubQuotas[id] = { loading: true, error: '', data: null }
            this.githubQuotaInflight += 1
            try {
              const resp = await fetch('/api/admin/copilot-quota/' + encodeURIComponent(id), {
                credentials: 'same-origin',
              })
              if (resp.ok) {
                const data = await resp.json()
                this.githubQuotas[id] = { loading: false, error: '', data }
              } else {
                let errText = ''
                try { const j = await resp.json(); errText = j?.error || ''; } catch (_e) {}
                this.githubQuotas[id] = { loading: false, error: errText || ('HTTP ' + resp.status), data: null }
              }
            } catch (_e) {
              this.githubQuotas[id] = { loading: false, error: this.t('dash.quotaLoadFailed'), data: null }
            } finally {
              this.githubQuotaInflight -= 1
            }
          },

          formatQuotaChip(q) {
            if (!q) return '…'
            if (q.loading) return '…'
            if (q.error) return '!'
            const snaps = q.data && q.data.quota_snapshots
            if (!snaps) return '—'
            const snap = snaps.premium_interactions
              || snaps.chat
              || snaps.completions
              || (Object.values(snaps).find(s => s && (s.unlimited || typeof s.entitlement === 'number')))
            if (!snap) return '—'
            if (snap.unlimited) return '∞'
            const used = (snap.entitlement || 0) - (snap.remaining || 0)
            return used + '/' + snap.entitlement
          },
```

- [ ] **Step 3: Trigger fan-out at the end of `loadAdminUsers`**

In the same `loadAdminUsers` method, find the `try { ... }` block that assigns `this.adminUsers = data` (or similar — the line that stores the parsed response). Immediately after that assignment, before the `}` that closes the success branch, append:

```js
                // Reset previous quota cache when re-loading user list
                this.githubQuotas = {}
                const ghIds = []
                for (const u of this.adminUsers) {
                  for (const gh of (u.githubAccounts || [])) {
                    if (gh && gh.id != null) ghIds.push(gh.id)
                  }
                }
                ghIds.forEach(id => { this.loadGithubQuota(id) })
```

- [ ] **Step 4: Manual smoke check**

Run: `bun run dev` (or whatever local dev script is in `package.json` — likely `bun run local`).
Sign in as admin → open Settings → Users panel. Open browser DevTools Network and verify one `GET /api/admin/copilot-quota/<id>` request fires per GitHub account in the list.
Expected: requests fire; failures from real GitHub for a given account don't block other accounts.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard/client.ts
git commit -m "feat(dashboard): admin fan-out fetch of per-account Copilot quota"
```

---

### Task 5: Render chip beside `@login`

**Files:**
- Modify: `src/ui/dashboard/tabs.ts:193-195`

- [ ] **Step 1: Replace the existing `@login` template**

Open `src/ui/dashboard/tabs.ts`. Find the block (around line 193):

```html
                    <template x-for="gh in (u.githubAccounts || [])" :key="gh.id">
                      <span class="text-xs text-themed-dim" x-text="'@' + gh.login"></span>
                    </template>
```

Replace it with:

```html
                    <template x-for="gh in (u.githubAccounts || [])" :key="gh.id">
                      <span class="inline-flex items-center gap-1">
                        <span class="text-xs text-themed-dim" x-text="'@' + gh.login"></span>
                        <span
                          class="text-[10px] px-1.5 py-0.5 rounded"
                          :class="githubQuotas[gh.id]?.error ? 'bg-accent-red/10 text-accent-red' : 'bg-accent-violet/10 text-accent-violet'"
                          :title="githubQuotas[gh.id]?.error || t('dash.copilotQuota')"
                          x-text="formatQuotaChip(githubQuotas[gh.id])"
                        ></span>
                      </span>
                    </template>
```

- [ ] **Step 2: Manual smoke check**

Reload the dashboard. For each user with a linked GitHub account you should see a small chip next to `@login` showing either `…` (loading), `used/entitlement` (e.g. `432/1500`), `∞`, `—`, or `!` (with hover tooltip showing the error).

- [ ] **Step 3: Commit**

```bash
git add src/ui/dashboard/tabs.ts
git commit -m "feat(dashboard): show Copilot quota chip beside admin GitHub-account login"
```

---

### Task 6: Final regression check

- [ ] **Step 1: Run targeted tests**

Run: `bun test tests/admin-copilot-quota.test.ts tests/key-sharing.test.ts tests/auth-change-password.test.ts`
Expected: all pass (5 + 10 + 7 = 22).

- [ ] **Step 2: Run the rest of the unit suite (skip server-required SDK tests)**

Run: `bun test tests/ --bail 2>&1 | tail -10`
Expected: pre-existing SDK integration failures unchanged; no new failures introduced by this branch.

- [ ] **Step 3: Optional commit if anything was touched**

If Step 1/2 surface anything that needed a fix, commit it. Otherwise no action.

---

## Self-Review

**Spec coverage:**
- Goal "admin sees quota per GitHub account in user list" → Tasks 4+5
- Backend endpoint contract (auth, lookup, upstream call, error matrix) → Task 2 + Task 1 covers all 5 error/success rows of the matrix
- Repo additions = none, reuse `listAccounts()` → Task 2 step 1 implements exactly this
- i18n keys (`dash.copilotQuota`, `dash.quotaLoadFailed`) → Task 3
- Frontend state shape (`githubQuotas[id] = { loading, error, data }`) → Task 4 step 1+2 (matches spec)
- Frontend fan-out trigger at end of `loadAdminUsers` → Task 4 step 3
- Chip render at `tabs.ts:193-195` → Task 5
- Test cases (admin happy / non-admin / unknown id / upstream 401 / fetch throw) → Task 1 (5 tests, one per matrix row)

**Placeholder scan:** None — every code block is concrete, every command has expected output.

**Type consistency:** `githubQuotas[id]` shape (`{ loading, error, data }`) is identical in `loadGithubQuota` (Task 4), `formatQuotaChip` (Task 4), and the chip template (Task 5). Endpoint path `/api/admin/copilot-quota/:githubUserId` is identical in route (Task 2), tests (Task 1), and frontend fetch (Task 4).
