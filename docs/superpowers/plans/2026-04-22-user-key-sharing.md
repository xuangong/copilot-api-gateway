# User-Facing Key Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any key owner share their API key with another user by email, see who they have shared with, and unshare — without exposing the user list. Admin's existing flow stays unchanged.

**Architecture:** Widen the guard on the existing admin `assign`/`unassign` endpoints to allow the key owner. Extend `POST /api/keys/:id/assign` body to also accept `{ email }`. Add an email-based share form and per-assignee unshare buttons to the existing "Shared With" panel in the dashboard.

**Tech Stack:** Bun + Elysia (backend), SQLite repo, Alpine.js + Tailwind dashboard, `bun test`.

---

## File Structure

- `src/routes/api-keys.ts` — extend `POST /:id/assign` (email path + owner-or-admin guard, validation, 409 duplicate); widen `DELETE /:id/assign/:userId` guard. The guard is inlined in both handlers (no shared helper — duplication is two small blocks).
- `tests/key-sharing.test.ts` — **new** test file covering all assign/unassign cases via direct route invocation against an in-memory sqlite repo (mirrors the style of existing `tests/*.test.ts`).
- `src/ui/dashboard/tabs.ts` — keep existing "Shared With" panel; add Unshare `✕` button per assignee chip; add a new email-input share form below the chip list.
- `src/ui/dashboard/client.ts` — add `shareEmail`, `shareError`, `shareKey()`, `unshareKey(userId)` methods on the dashboard component; reload keys after success.
- `src/ui/dashboard/i18n.ts` (or wherever `dash.sharedWith` is defined) — add `dash.share`, `dash.unshare`, `dash.shareEmailPlaceholder`, plus error strings (`dash.shareErrNoUser`, `dash.shareErrSelf`, `dash.shareErrDuplicate`, `dash.shareErrForbidden`, `dash.shareErrGeneric`, `dash.shareErrInvalidEmail`).

---

## Task 1: Add backend tests (TDD red phase)

**Files:**
- Create: `tests/key-sharing.test.ts`

- [ ] **Step 1: Inspect an existing test for repo setup pattern**

Run: `cat tests/storage.test.ts | head -50` and `cat tests/sse-heartbeat.test.ts | head -40`

Expected: see how the suite boots an in-memory sqlite repo and an Elysia app for routes. Reuse the same boot helpers in the new file (look for `setRepo`, `new SqliteRepo(":memory:")`, or whatever is conventional).

If no shared helper exists in tests/ already, build one inline at the top of the new test file: import `SqliteRepo` from `~/repo/sqlite`, instantiate with `":memory:"`, register via `setRepo` from `~/repo/index`. Insert two seed users (`owner`, `friend`) with emails `owner@example.com` and `friend@example.com` via `repo.users.create(...)`. Insert one api_key via `createApiKey({ name: "k1", ownerId: owner.id })`.

- [ ] **Step 2: Write the failing tests**

```ts
// tests/key-sharing.test.ts
import { test, expect, beforeEach } from "bun:test"
import { Elysia } from "elysia"
import { apiKeysRoute } from "~/routes/api-keys"
import { SqliteRepo } from "~/repo/sqlite"
import { setRepo, getRepo } from "~/repo"
import { createApiKey } from "~/lib/api-keys"

let app: Elysia
let ownerId: string
let friendId: string
let strangerId: string
let keyId: string

async function callAs(ctx: Record<string, any>, method: string, path: string, body?: any) {
  // Inject auth ctx via header; the routes read it from the Elysia ctx fields
  // (matches how server.ts injects auth: see src/server.ts auth middleware).
  // If the project's actual injection is different, use the same mechanism here.
  const headers: Record<string, string> = { "Content-Type": "application/json", "x-test-auth": JSON.stringify(ctx) }
  return app.handle(new Request(`http://localhost${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }))
}

beforeEach(async () => {
  setRepo(new SqliteRepo(":memory:"))
  const repo = getRepo()
  const now = new Date().toISOString()
  await repo.users.create({ id: "u-owner", name: "Owner", email: "owner@example.com", createdAt: now, disabled: false })
  await repo.users.create({ id: "u-friend", name: "Friend", email: "friend@example.com", createdAt: now, disabled: false })
  await repo.users.create({ id: "u-stranger", name: "Stranger", email: "stranger@example.com", createdAt: now, disabled: false })
  ownerId = "u-owner"; friendId = "u-friend"; strangerId = "u-stranger"
  const k = await createApiKey({ name: "k1", ownerId })
  keyId = k.id
  app = new Elysia().use(
    new Elysia().derive(({ request }) => {
      const raw = request.headers.get("x-test-auth")
      return raw ? JSON.parse(raw) : {}
    }).use(apiKeysRoute)
  )
})

test("owner shares by email → 200 and assignment recorded", async () => {
  const r = await callAs({ isUser: true, userId: ownerId }, "POST", `/api/keys/${keyId}/assign`, { email: "friend@example.com" })
  expect(r.status).toBe(200)
  const list = await getRepo().keyAssignments.listByKey(keyId)
  expect(list.map(a => a.userId)).toContain(friendId)
})

test("owner shares with non-existent email → 404", async () => {
  const r = await callAs({ isUser: true, userId: ownerId }, "POST", `/api/keys/${keyId}/assign`, { email: "nobody@example.com" })
  expect(r.status).toBe(404)
  const body = await r.json()
  expect(body.error).toBe("No user with that email")
})

test("owner cannot share key with self → 400", async () => {
  const r = await callAs({ isUser: true, userId: ownerId }, "POST", `/api/keys/${keyId}/assign`, { email: "owner@example.com" })
  expect(r.status).toBe(400)
  const body = await r.json()
  expect(body.error).toBe("Cannot share key with yourself")
})

test("owner shares same email twice → 409", async () => {
  await callAs({ isUser: true, userId: ownerId }, "POST", `/api/keys/${keyId}/assign`, { email: "friend@example.com" })
  const r = await callAs({ isUser: true, userId: ownerId }, "POST", `/api/keys/${keyId}/assign`, { email: "friend@example.com" })
  expect(r.status).toBe(409)
  const body = await r.json()
  expect(body.error).toBe("Already shared with this user")
})

test("stranger (not owner, not admin) cannot share → 403", async () => {
  const r = await callAs({ isUser: true, userId: strangerId }, "POST", `/api/keys/${keyId}/assign`, { email: "friend@example.com" })
  expect(r.status).toBe(403)
})

test("admin assigns by user_id → 200 (regression)", async () => {
  const r = await callAs({ isAdmin: true, userId: "admin" }, "POST", `/api/keys/${keyId}/assign`, { user_id: friendId })
  expect(r.status).toBe(200)
})

test("missing user_id and email → 400", async () => {
  const r = await callAs({ isUser: true, userId: ownerId }, "POST", `/api/keys/${keyId}/assign`, {})
  expect(r.status).toBe(400)
  const body = await r.json()
  expect(body.error).toBe("user_id or email is required")
})

test("owner unshares → 200 and assignment removed", async () => {
  await getRepo().keyAssignments.assign(keyId, friendId, ownerId)
  const r = await callAs({ isUser: true, userId: ownerId }, "DELETE", `/api/keys/${keyId}/assign/${friendId}`)
  expect(r.status).toBe(200)
  const list = await getRepo().keyAssignments.listByKey(keyId)
  expect(list.find(a => a.userId === friendId)).toBeUndefined()
})

test("stranger cannot unshare → 403", async () => {
  await getRepo().keyAssignments.assign(keyId, friendId, ownerId)
  const r = await callAs({ isUser: true, userId: strangerId }, "DELETE", `/api/keys/${keyId}/assign/${friendId}`)
  expect(r.status).toBe(403)
})

test("owner unshare for non-existent assignment → 200 (idempotent)", async () => {
  const r = await callAs({ isUser: true, userId: ownerId }, "DELETE", `/api/keys/${keyId}/assign/${friendId}`)
  expect(r.status).toBe(200)
})
```

> If the actual auth injection mechanism differs (e.g., a real middleware sets `ctx.userId` from a session cookie), wire the test to it the same way. The point is: the route handlers must see `isAdmin`, `isUser`, `userId` on `ctx`. Use whatever the existing tests do for parity.

- [ ] **Step 3: Run the tests; expect failures on the new code paths**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway && bun test tests/key-sharing.test.ts`

Expected: the four "owner shares ..." tests fail with `403 "Admin only"` from the current code. The "admin assigns by user_id" and "missing user_id and email → 400" probably already pass. The "owner unshares" tests fail with `403 "Admin only"`.

- [ ] **Step 4: Commit**

```bash
git add tests/key-sharing.test.ts
git commit -m "test(api-keys): cover owner+email share, duplicate, self, stranger, unshare"
```

---

## Task 2: Backend — owner-or-admin guard + email path on POST /assign

**Files:**
- Modify: `src/routes/api-keys.ts:272-294`

- [ ] **Step 1: Replace the POST /assign handler**

Open `src/routes/api-keys.ts`. Replace the block currently at lines 272–294 (the `.post("/:id/assign", …)` handler) with the version below. Do not touch anything else in the file.

```ts
  // POST /api/keys/:id/assign - assign key to a user (admin or key owner)
  // Body: { user_id?: string, email?: string }  (exactly one required)
  .post("/:id/assign", async (ctx) => {
    const { params, body } = ctx
    const authCtx = ctx as unknown as AuthCtx
    const key = await getApiKeyById(params.id)
    if (!key) {
      return new Response(JSON.stringify({ error: "Key not found" }), { status: 404, headers: { "Content-Type": "application/json" } })
    }
    const isOwner = !!authCtx.userId && key.ownerId === authCtx.userId
    if (!authCtx.isAdmin && !isOwner) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    const { user_id, email } = (body ?? {}) as { user_id?: string; email?: string }
    if (!user_id && !email) {
      return new Response(JSON.stringify({ error: "user_id or email is required" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }
    const repo = getRepo()
    let targetUser = null as Awaited<ReturnType<typeof repo.users.getById>>
    if (user_id) {
      targetUser = await repo.users.getById(user_id)
      if (!targetUser) {
        return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: { "Content-Type": "application/json" } })
      }
    } else if (email) {
      targetUser = await repo.users.findByEmail(email.trim().toLowerCase())
      if (!targetUser) {
        return new Response(JSON.stringify({ error: "No user with that email" }), { status: 404, headers: { "Content-Type": "application/json" } })
      }
    }
    if (!targetUser) {
      return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: { "Content-Type": "application/json" } })
    }
    if (targetUser.id === key.ownerId) {
      return new Response(JSON.stringify({ error: "Cannot share key with yourself" }), { status: 400, headers: { "Content-Type": "application/json" } })
    }
    const existing = await repo.keyAssignments.listByKey(params.id)
    if (existing.some(a => a.userId === targetUser!.id)) {
      return new Response(JSON.stringify({ error: "Already shared with this user" }), { status: 409, headers: { "Content-Type": "application/json" } })
    }
    await repo.keyAssignments.assign(params.id, targetUser.id, authCtx.userId || "admin")
    return { ok: true }
  })
```

- [ ] **Step 2: Run the assign tests**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway && bun test tests/key-sharing.test.ts -t "shares\|admin assigns\|missing user_id\|cannot share key with self\|same email twice\|stranger.*cannot share"`

Expected: all 7 POST-related tests pass. Unshare tests still fail (handled in Task 3).

- [ ] **Step 3: Commit**

```bash
git add src/routes/api-keys.ts
git commit -m "feat(api-keys): owner can share key by email (assign endpoint)"
```

---

## Task 3: Backend — owner-or-admin guard on DELETE /assign/:userId

**Files:**
- Modify: `src/routes/api-keys.ts:296-305`

- [ ] **Step 1: Replace the DELETE /assign/:userId handler**

```ts
  // DELETE /api/keys/:id/assign/:userId - unassign key from a user (admin or key owner)
  .delete("/:id/assign/:userId", async (ctx) => {
    const { params } = ctx
    const authCtx = ctx as unknown as AuthCtx
    const key = await getApiKeyById(params.id)
    if (!key) {
      return new Response(JSON.stringify({ error: "Key not found" }), { status: 404, headers: { "Content-Type": "application/json" } })
    }
    const isOwner = !!authCtx.userId && key.ownerId === authCtx.userId
    if (!authCtx.isAdmin && !isOwner) {
      return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    await getRepo().keyAssignments.unassign(params.id, params.userId)
    return { ok: true }
  })
```

- [ ] **Step 2: Run the full sharing test file**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway && bun test tests/key-sharing.test.ts`

Expected: all tests pass.

- [ ] **Step 3: Run the broader suite to catch regressions**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway && bun test`

Expected: no new failures. (Pre-existing failures, if any, should be unchanged — call them out but do not fix here.)

- [ ] **Step 4: Commit**

```bash
git add src/routes/api-keys.ts
git commit -m "feat(api-keys): owner can unshare own key (assign DELETE endpoint)"
```

---

## Task 4: Frontend — add i18n strings

**Files:**
- Modify: `src/ui/dashboard/i18n.ts` (or whichever file defines `dash.sharedWith`)

- [ ] **Step 1: Locate the i18n file**

Run: `grep -rn "dash.sharedWith" src/ui/dashboard/`

Open the file containing the English entries.

- [ ] **Step 2: Add new strings**

Add the following keys to both the `en` and `zh` (or whatever locales exist) blocks. Use the existing block style for whitespace/quotes.

```ts
// en
'dash.share': 'Share',
'dash.unshare': 'Unshare',
'dash.shareEmailPlaceholder': 'user@example.com',
'dash.shareErrNoUser': 'No user with that email',
'dash.shareErrSelf': "You can't share a key with yourself",
'dash.shareErrDuplicate': 'Already shared with this user',
'dash.shareErrForbidden': 'Not allowed',
'dash.shareErrInvalidEmail': 'Enter a valid email',
'dash.shareErrGeneric': 'Failed to share',
'dash.unshareToast': 'Unshared',
'dash.shareToast': 'Shared',
```

```ts
// zh
'dash.share': '分享',
'dash.unshare': '取消分享',
'dash.shareEmailPlaceholder': 'user@example.com',
'dash.shareErrNoUser': '该邮箱对应的用户不存在',
'dash.shareErrSelf': '不能分享给自己',
'dash.shareErrDuplicate': '已经分享给该用户',
'dash.shareErrForbidden': '没有权限',
'dash.shareErrInvalidEmail': '请输入有效邮箱',
'dash.shareErrGeneric': '分享失败',
'dash.unshareToast': '已取消分享',
'dash.shareToast': '已分享',
```

If the project has only one locale, add only that locale.

- [ ] **Step 3: Commit**

```bash
git add src/ui/dashboard/i18n.ts
git commit -m "i18n(dashboard): add key share/unshare strings"
```

---

## Task 5: Frontend — add `shareKey` / `unshareKey` to dashboard component

**Files:**
- Modify: `src/ui/dashboard/client.ts`

- [ ] **Step 1: Locate component data section**

Open `src/ui/dashboard/client.ts`. Find the Alpine component definition (search for `selectedKeyId:` to land near the keys-related state). Confirm where `data()` returns the component state object.

- [ ] **Step 2: Add reactive state**

Inside that returned object, near `selectedKeyId`, add:

```js
shareEmail: '',
shareError: '',
sharing: false,
```

- [ ] **Step 3: Add `shareKey` and `unshareKey` methods**

Inside the methods section of the same component (sibling to `loadKeys`, `loadQuotaUsage`, etc.), add:

```js
async shareKey() {
  this.shareError = '';
  const email = (this.shareEmail || '').trim();
  if (!email || !email.includes('@')) {
    this.shareError = this.t('dash.shareErrInvalidEmail');
    return;
  }
  if (!this.selectedKeyId) return;
  this.sharing = true;
  try {
    const resp = await fetch('/api/keys/' + encodeURIComponent(this.selectedKeyId) + '/assign', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (resp.ok) {
      this.shareEmail = '';
      this.toast && this.toast(this.t('dash.shareToast') + ': ' + email);
      await this.loadKeys();
      return;
    }
    if (resp.status === 404) this.shareError = this.t('dash.shareErrNoUser');
    else if (resp.status === 400) this.shareError = this.t('dash.shareErrSelf');
    else if (resp.status === 409) this.shareError = this.t('dash.shareErrDuplicate');
    else if (resp.status === 403) this.shareError = this.t('dash.shareErrForbidden');
    else this.shareError = this.t('dash.shareErrGeneric');
  } catch (_e) {
    this.shareError = this.t('dash.shareErrGeneric');
  } finally {
    this.sharing = false;
  }
},

async unshareKey(userId) {
  if (!this.selectedKeyId || !userId) return;
  try {
    const resp = await fetch('/api/keys/' + encodeURIComponent(this.selectedKeyId) + '/assign/' + encodeURIComponent(userId), {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (resp.ok) {
      this.toast && this.toast(this.t('dash.unshareToast'));
      await this.loadKeys();
    }
  } catch (_e) { /* ignore */ }
},
```

> If the component does not currently expose a `toast` helper, just drop the `this.toast && this.toast(...)` calls — silent success after re-fetch is acceptable.

- [ ] **Step 4: Clear `shareError` on input change (small UX fix)**

Find the keys table panel rendered by `tabs.ts`. The input we add in Task 6 has `@input="shareError=''"`. Verify nothing else needs to change in `client.ts` for that.

- [ ] **Step 5: Commit**

```bash
git add src/ui/dashboard/client.ts
git commit -m "feat(dashboard): add shareKey/unshareKey methods"
```

---

## Task 6: Frontend — add share form + Unshare buttons to "Shared With" panel

**Files:**
- Modify: `src/ui/dashboard/tabs.ts:571-584`

- [ ] **Step 1: Replace the panel block**

Replace the block currently at lines 571–584 with:

```html
      <!-- Shared Users Panel -->
      <!-- Shown for owned keys; lets owner share by email and unshare individuals. -->
      <template x-if="selectedKeyId && keys.find(k => k.id === selectedKeyId)?.is_owner !== false">
        <div class="glass-card p-6 mb-6 animate-in delay-1">
          <span class="text-xs font-medium text-themed-dim uppercase tracking-widest" x-text="t('dash.sharedWith')"></span>
          <div class="flex flex-wrap gap-2 mt-3">
            <template x-for="a in keys.find(k => k.id === selectedKeyId)?.assignees || []" :key="a.user_id">
              <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-accent-violet/10 text-accent-violet border border-accent-violet/20">
                <svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                <span x-text="a.user_name || 'Unknown'"></span>
                <button type="button"
                        class="ml-1 -mr-0.5 opacity-60 hover:opacity-100"
                        :title="t('dash.unshare')"
                        @click="unshareKey(a.user_id)">×</button>
              </span>
            </template>
          </div>
          <div class="mt-3 flex items-center gap-2">
            <input type="email"
                   class="flex-1 min-w-0 px-3 py-1.5 rounded text-sm bg-themed border border-themed-dim/30 focus:outline-none focus:border-accent-violet"
                   :placeholder="t('dash.shareEmailPlaceholder')"
                   x-model="shareEmail"
                   @input="shareError=''"
                   @keydown.enter.prevent="shareKey()" />
            <button type="button"
                    class="px-3 py-1.5 rounded text-sm bg-accent-violet/10 text-accent-violet border border-accent-violet/20 hover:bg-accent-violet/20 disabled:opacity-50"
                    :disabled="sharing || !shareEmail"
                    @click="shareKey()"
                    x-text="t('dash.share')"></button>
          </div>
          <div class="mt-2 text-xs text-red-400" x-show="shareError" x-text="shareError"></div>
        </div>
      </template>
```

Notes:
- The outer `x-if` no longer requires `assignees.length > 0` — owner should always see the input, even when there are zero assignees.
- The `×` button per assignee triggers `unshareKey`.
- `@keydown.enter.prevent` lets the user submit by pressing Enter.

- [ ] **Step 2: Manual smoke test**

Run the dev server (`bun run dev` or whatever the project uses — check `package.json` scripts). Open the dashboard as a non-admin user, select an owned key, and verify:
1. Empty share input + Share button appears under "Shared With".
2. Typing a non-existent email + Share → red error "No user with that email".
3. Typing your own email → red "You can't share a key with yourself".
4. Typing a valid friend email → chip appears, input clears.
5. Typing the same email again → red "Already shared with this user".
6. Click `×` next to a chip → chip disappears.
7. Switch to a key shared *to* you (`is_owner=false`): the panel does NOT render.

- [ ] **Step 3: Commit**

```bash
git add src/ui/dashboard/tabs.ts
git commit -m "feat(dashboard): owner share-by-email form + per-assignee unshare button"
```

---

## Task 7: Final verification

- [ ] **Step 1: Run full test suite**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway && bun test`

Expected: all tests pass; sharing tests included.

- [ ] **Step 2: Type check**

Run: `cd /Users/zhangxian/projects/copilot-api-gateway && bun run typecheck` (or `bunx tsc --noEmit` if no script exists).

Expected: clean.

- [ ] **Step 3: Confirm admin flow regression-free**

Manual: log in as admin, open Users tab, open the per-user assign modal — verify it still lists all users and assigning works as before.

- [ ] **Step 4: Done — no commit if everything green**

If verification turned up a regression, fix in a follow-up task and commit; otherwise the implementation is complete.
