# Share Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow an owner to grant a viewer one-way, read-only access to all observability panels (Copilot quota, token usage, latency, relays, upstream accounts) on the dashboard, never exposing key plaintext, key IDs, OAuth tokens, or relay infrastructure metadata.

**Architecture:** New `observability_shares` table + `ObservabilityShareRepo` (SQLite + D1). Backend `resolveViewContext` middleware honors `?as_user=<ownerId>` only for session auth, gated by `isGranted` check. Closed allowlist of endpoints accept `as_user`; all others ignore it. Shared responses pass through `redactForSharedView` which strips sensitive fields and replaces internal IDs with HMAC surrogates (`sharedKeyRef`/`sharedAccountRef`/`sharedRelayRef`). Frontend dropdown switches view context; Keys tab hidden + triply guarded; share-management modal in user menu.

**Tech Stack:** Bun + Elysia + bun:sqlite (local) / Cloudflare D1 (prod), Alpine.js dashboard, bun:test.

**Spec:** `docs/superpowers/specs/2026-04-23-share-observability-design.md`

---

## File Structure

**Created:**
- `migrations/0018_observability_shares.sql` — D1 migration
- `src/middleware/view-context.ts` — `resolveViewContext` Elysia plugin + `getOwnedKeyIdsForScope`
- `src/lib/redact-shared-view.ts` — HMAC surrogates + `redactForSharedView`
- `src/routes/observability-shares.ts` — share-management endpoints
- `src/routes/upstream-accounts.ts` — new `/api/upstream-accounts` (extracted from `/auth/me`)
- `tests/observability-share-repo.test.ts`
- `tests/view-context.test.ts`
- `tests/redact-shared-view.test.ts`
- `tests/observability-share-routes.test.ts`
- `tests/observability-share-integration.test.ts`

**Modified:**
- `src/repo/types.ts` — add `ObservabilityShare` + `ObservabilityShareRepo` + extend `Repo`
- `src/repo/sqlite.ts` — `SqliteObservabilityShareRepo` + `migrateSchema` + wire into `SqliteRepo`
- `src/repo/d1.ts` — `D1ObservabilityShareRepo` + wire into `D1Repo`
- `src/index.ts` — extend `authCheck` return with `authKind`; mount new routes
- `src/routes/dashboard.ts` — refactor `/api/copilot-quota`, `/api/token-usage`, `/api/latency`, `/api/relays` to honor `effectiveUserId` + apply `redactForSharedView`
- `src/routes/auth.ts` — trim `/auth/me` accounts (move to upstream route); call `repo.observabilityShares.deleteByOwner` + `deleteByViewer` in user-delete cascade
- `src/ui/dashboard/client.ts` — Alpine state additions, `observabilityFetch`, boot sequence, `switchViewAs`, hash guard, `switchTab` interception, key-state clear, 403 fallback
- `src/ui/dashboard/tabs.ts` — header dropdown, banner, "My Sharing" menu item, share modal, hide Keys nav under viewAs, upstream row guard, relay column hides
- `src/i18n/en.ts` + `src/i18n/zh.ts` (or whichever the dashboard uses) — new `dash.*` keys

---

## Conventions

- Tests: `bun test tests/<file>` — single file. `bun test` — all.
- All commits use Conventional Commits (`feat:`, `test:`, `refactor:`, `fix:`).
- TDD: every task writes failing tests first, runs to verify failure, implements minimal code, verifies pass, commits.
- After each task, the implementer self-reviews diff for spec compliance and code quality.

---

### Task 1: Add `ObservabilityShare` types + extend `Repo` interface (red-only)

**Files:**
- Modify: `src/repo/types.ts:241-254` (extend `Repo`); insert new types after line 221

- [ ] **Step 1: Add types and repo interface**

In `src/repo/types.ts`, after the `KeyAssignmentRepo` block (line 221) and before `DeviceCode` (line 223), insert:

```ts
export interface ObservabilityShare {
  ownerId: string
  viewerId: string
  grantedBy: string
  grantedAt: string
}

export interface ObservabilityShareRepo {
  share(ownerId: string, viewerId: string, grantedBy: string): Promise<void>
  unshare(ownerId: string, viewerId: string): Promise<void>
  listByOwner(ownerId: string): Promise<ObservabilityShare[]>
  listByViewer(viewerId: string): Promise<ObservabilityShare[]>
  isGranted(ownerId: string, viewerId: string): Promise<boolean>
  deleteByOwner(ownerId: string): Promise<void>
  deleteByViewer(viewerId: string): Promise<void>
}
```

In the same file, extend the `Repo` interface (lines 241-254) by adding `observabilityShares: ObservabilityShareRepo` directly after `keyAssignments: KeyAssignmentRepo` (line 252).

- [ ] **Step 2: Re-export from `src/repo/index.ts`**

In `src/repo/index.ts:3`, add `ObservabilityShare, ObservabilityShareRepo` to the type re-export list:

```ts
export type { Repo, ApiKey, GitHubAccount, GitHubUser, UsageRecord, LatencyRecord, User, InviteCode, UserSession, ClientPresence, WebSearchUsageRecord, ObservabilityShare, ObservabilityShareRepo } from "./types"
```

- [ ] **Step 3: Verify type-check fails**

Run: `bun run tsc --noEmit` (or whatever `bun run typecheck` resolves to)

Expected: errors in `src/repo/sqlite.ts` and `src/repo/d1.ts` saying `Class 'SqliteRepo' incorrectly implements interface 'Repo'. Property 'observabilityShares' is missing` (and the same for `D1Repo`). This is the desired red state — Task 2 / Task 3 implement them.

- [ ] **Step 4: Commit**

```bash
git add src/repo/types.ts src/repo/index.ts
git commit -m "feat(repo): add ObservabilityShare types and repo interface"
```

---

### Task 2: SQLite migration + `SqliteObservabilityShareRepo`

**Files:**
- Create: `migrations/0018_observability_shares.sql`
- Modify: `src/repo/sqlite.ts` (add class after line 696; add migration in `migrateSchema` after line 572; wire into `SqliteRepo` at lines 740-769)
- Create: `tests/observability-share-repo.test.ts`

- [ ] **Step 1: Create the D1 migration file**

Create `migrations/0018_observability_shares.sql`:

```sql
-- Observability sharing — owner grants viewer read-only access to observability data
CREATE TABLE observability_shares (
  owner_id TEXT NOT NULL,
  viewer_id TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, viewer_id)
);
CREATE INDEX idx_observability_shares_viewer ON observability_shares(viewer_id);
```

- [ ] **Step 2: Write the failing test**

Create `tests/observability-share-repo.test.ts`:

```ts
import { test, expect, beforeEach, describe } from "bun:test"
import { Database } from "bun:sqlite"
import { SqliteRepo } from "../src/repo/sqlite"

let repo: SqliteRepo

beforeEach(() => {
  repo = new SqliteRepo(new Database(":memory:"))
})

describe("ObservabilityShareRepo (sqlite)", () => {
  test("share + isGranted true", async () => {
    await repo.observabilityShares.share("owner-1", "viewer-1", "owner-1")
    expect(await repo.observabilityShares.isGranted("owner-1", "viewer-1")).toBe(true)
  })

  test("isGranted false when not shared", async () => {
    expect(await repo.observabilityShares.isGranted("owner-1", "viewer-1")).toBe(false)
  })

  test("isGranted is directional (viewer cannot view owner's reverse)", async () => {
    await repo.observabilityShares.share("owner-1", "viewer-1", "owner-1")
    expect(await repo.observabilityShares.isGranted("viewer-1", "owner-1")).toBe(false)
  })

  test("share is idempotent", async () => {
    await repo.observabilityShares.share("owner-1", "viewer-1", "owner-1")
    await repo.observabilityShares.share("owner-1", "viewer-1", "owner-1")
    const list = await repo.observabilityShares.listByOwner("owner-1")
    expect(list).toHaveLength(1)
  })

  test("unshare removes the grant", async () => {
    await repo.observabilityShares.share("owner-1", "viewer-1", "owner-1")
    await repo.observabilityShares.unshare("owner-1", "viewer-1")
    expect(await repo.observabilityShares.isGranted("owner-1", "viewer-1")).toBe(false)
  })

  test("listByOwner returns all viewers granted by owner", async () => {
    await repo.observabilityShares.share("owner-1", "viewer-1", "owner-1")
    await repo.observabilityShares.share("owner-1", "viewer-2", "owner-1")
    await repo.observabilityShares.share("owner-2", "viewer-1", "owner-2")
    const list = await repo.observabilityShares.listByOwner("owner-1")
    expect(list.map(s => s.viewerId).sort()).toEqual(["viewer-1", "viewer-2"])
  })

  test("listByViewer returns all owners that granted this viewer", async () => {
    await repo.observabilityShares.share("owner-1", "viewer-1", "owner-1")
    await repo.observabilityShares.share("owner-2", "viewer-1", "owner-2")
    await repo.observabilityShares.share("owner-1", "viewer-2", "owner-1")
    const list = await repo.observabilityShares.listByViewer("viewer-1")
    expect(list.map(s => s.ownerId).sort()).toEqual(["owner-1", "owner-2"])
  })

  test("deleteByOwner removes all grants by an owner", async () => {
    await repo.observabilityShares.share("owner-1", "viewer-1", "owner-1")
    await repo.observabilityShares.share("owner-1", "viewer-2", "owner-1")
    await repo.observabilityShares.share("owner-2", "viewer-1", "owner-2")
    await repo.observabilityShares.deleteByOwner("owner-1")
    expect(await repo.observabilityShares.listByOwner("owner-1")).toHaveLength(0)
    expect(await repo.observabilityShares.listByOwner("owner-2")).toHaveLength(1)
  })

  test("deleteByViewer removes all grants to a viewer", async () => {
    await repo.observabilityShares.share("owner-1", "viewer-1", "owner-1")
    await repo.observabilityShares.share("owner-2", "viewer-1", "owner-2")
    await repo.observabilityShares.share("owner-1", "viewer-2", "owner-1")
    await repo.observabilityShares.deleteByViewer("viewer-1")
    expect(await repo.observabilityShares.listByViewer("viewer-1")).toHaveLength(0)
    expect(await repo.observabilityShares.listByViewer("viewer-2")).toHaveLength(1)
  })

  test("grantedAt is an ISO timestamp", async () => {
    await repo.observabilityShares.share("owner-1", "viewer-1", "owner-1")
    const [s] = await repo.observabilityShares.listByOwner("owner-1")
    expect(new Date(s.grantedAt).toString()).not.toBe("Invalid Date")
    expect(s.grantedBy).toBe("owner-1")
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/observability-share-repo.test.ts`

Expected: fails with `repo.observabilityShares is undefined` (the field doesn't exist on `SqliteRepo` yet).

- [ ] **Step 4: Add the migration call to `migrateSchema`**

In `src/repo/sqlite.ts`, in `migrateSchema` after the `key_assignments` block (line 572), before `device_codes`:

```ts
  // Observability shares table
  db.exec(`CREATE TABLE IF NOT EXISTS observability_shares (
    owner_id TEXT NOT NULL,
    viewer_id TEXT NOT NULL,
    granted_by TEXT NOT NULL,
    granted_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, viewer_id)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_observability_shares_viewer ON observability_shares(viewer_id)`)
```

- [ ] **Step 5: Implement `SqliteObservabilityShareRepo`**

In `src/repo/sqlite.ts`, after `SqliteKeyAssignmentRepo` (line 696), before `SqliteDeviceCodeRepo` (line 698):

```ts
class SqliteObservabilityShareRepo implements ObservabilityShareRepo {
  constructor(private db: Database) {}

  async share(ownerId: string, viewerId: string, grantedBy: string): Promise<void> {
    this.db.query(
      "INSERT OR REPLACE INTO observability_shares (owner_id, viewer_id, granted_by, granted_at) VALUES (?, ?, ?, ?)"
    ).run(ownerId, viewerId, grantedBy, new Date().toISOString())
  }

  async unshare(ownerId: string, viewerId: string): Promise<void> {
    this.db.query("DELETE FROM observability_shares WHERE owner_id = ? AND viewer_id = ?").run(ownerId, viewerId)
  }

  async listByOwner(ownerId: string): Promise<ObservabilityShare[]> {
    return this.db.query<any, [string]>(
      "SELECT owner_id, viewer_id, granted_by, granted_at FROM observability_shares WHERE owner_id = ?"
    ).all(ownerId).map((r: any) => ({
      ownerId: r.owner_id, viewerId: r.viewer_id, grantedBy: r.granted_by, grantedAt: r.granted_at,
    }))
  }

  async listByViewer(viewerId: string): Promise<ObservabilityShare[]> {
    return this.db.query<any, [string]>(
      "SELECT owner_id, viewer_id, granted_by, granted_at FROM observability_shares WHERE viewer_id = ?"
    ).all(viewerId).map((r: any) => ({
      ownerId: r.owner_id, viewerId: r.viewer_id, grantedBy: r.granted_by, grantedAt: r.granted_at,
    }))
  }

  async isGranted(ownerId: string, viewerId: string): Promise<boolean> {
    const row = this.db.query<any, [string, string]>(
      "SELECT 1 FROM observability_shares WHERE owner_id = ? AND viewer_id = ? LIMIT 1"
    ).get(ownerId, viewerId)
    return !!row
  }

  async deleteByOwner(ownerId: string): Promise<void> {
    this.db.query("DELETE FROM observability_shares WHERE owner_id = ?").run(ownerId)
  }

  async deleteByViewer(viewerId: string): Promise<void> {
    this.db.query("DELETE FROM observability_shares WHERE viewer_id = ?").run(viewerId)
  }
}
```

Add `ObservabilityShare, ObservabilityShareRepo` to the imports from `./types` at the top of the file (find the existing type-only import line and append these two names).

- [ ] **Step 6: Wire into `SqliteRepo`**

In `src/repo/sqlite.ts`, the `SqliteRepo` class (lines 740-769):

Add field declaration after `keyAssignments` (line 751):

```ts
  observabilityShares: ObservabilityShareRepo
```

Add construction after `this.keyAssignments = ...` (line 767):

```ts
    this.observabilityShares = new SqliteObservabilityShareRepo(db)
```

- [ ] **Step 7: Run test to verify pass**

Run: `bun test tests/observability-share-repo.test.ts`

Expected: 10/10 tests pass.

- [ ] **Step 8: Commit**

```bash
git add migrations/0018_observability_shares.sql src/repo/sqlite.ts tests/observability-share-repo.test.ts
git commit -m "feat(repo): SqliteObservabilityShareRepo + 0018 migration"
```

---

### Task 3: `D1ObservabilityShareRepo`

**Files:**
- Modify: `src/repo/d1.ts` (add class after line 760; wire into `D1Repo` at lines 824-852)

- [ ] **Step 1: Implement `D1ObservabilityShareRepo`**

In `src/repo/d1.ts`, after `D1KeyAssignmentRepo` (line 760), before `D1DeviceCodeRepo` (line 762):

```ts
class D1ObservabilityShareRepo implements ObservabilityShareRepo {
  constructor(private db: D1Database) {}

  async share(ownerId: string, viewerId: string, grantedBy: string): Promise<void> {
    await this.db.prepare(
      "INSERT OR REPLACE INTO observability_shares (owner_id, viewer_id, granted_by, granted_at) VALUES (?, ?, ?, ?)"
    ).bind(ownerId, viewerId, grantedBy, new Date().toISOString()).run()
  }

  async unshare(ownerId: string, viewerId: string): Promise<void> {
    await this.db.prepare(
      "DELETE FROM observability_shares WHERE owner_id = ? AND viewer_id = ?"
    ).bind(ownerId, viewerId).run()
  }

  async listByOwner(ownerId: string): Promise<ObservabilityShare[]> {
    const { results } = await this.db.prepare(
      "SELECT owner_id, viewer_id, granted_by, granted_at FROM observability_shares WHERE owner_id = ?"
    ).bind(ownerId).all<{ owner_id: string; viewer_id: string; granted_by: string; granted_at: string }>()
    return results.map(r => ({ ownerId: r.owner_id, viewerId: r.viewer_id, grantedBy: r.granted_by, grantedAt: r.granted_at }))
  }

  async listByViewer(viewerId: string): Promise<ObservabilityShare[]> {
    const { results } = await this.db.prepare(
      "SELECT owner_id, viewer_id, granted_by, granted_at FROM observability_shares WHERE viewer_id = ?"
    ).bind(viewerId).all<{ owner_id: string; viewer_id: string; granted_by: string; granted_at: string }>()
    return results.map(r => ({ ownerId: r.owner_id, viewerId: r.viewer_id, grantedBy: r.granted_by, grantedAt: r.granted_at }))
  }

  async isGranted(ownerId: string, viewerId: string): Promise<boolean> {
    const row = await this.db.prepare(
      "SELECT 1 AS one FROM observability_shares WHERE owner_id = ? AND viewer_id = ? LIMIT 1"
    ).bind(ownerId, viewerId).first<{ one: number }>()
    return !!row
  }

  async deleteByOwner(ownerId: string): Promise<void> {
    await this.db.prepare("DELETE FROM observability_shares WHERE owner_id = ?").bind(ownerId).run()
  }

  async deleteByViewer(viewerId: string): Promise<void> {
    await this.db.prepare("DELETE FROM observability_shares WHERE viewer_id = ?").bind(viewerId).run()
  }
}
```

Add `ObservabilityShare, ObservabilityShareRepo` to the existing type-only import from `./types` at top of file.

- [ ] **Step 2: Wire into `D1Repo`**

In `src/repo/d1.ts`, the `D1Repo` class (lines 824-852):

Add field after `keyAssignments` (line 835):

```ts
  observabilityShares: ObservabilityShareRepo
```

Add construction after `this.keyAssignments = ...` (line 849):

```ts
    this.observabilityShares = new D1ObservabilityShareRepo(db)
```

- [ ] **Step 3: Verify type-check passes**

Run: `bun run tsc --noEmit`

Expected: no errors related to `observabilityShares` or `Repo` interface.

- [ ] **Step 4: Commit**

```bash
git add src/repo/d1.ts
git commit -m "feat(repo): D1ObservabilityShareRepo"
```

---

### Task 4: User-deletion cascade

**Files:**
- Modify: `src/routes/auth.ts:802-814` (admin user-delete handler)

- [ ] **Step 1: Add cascade calls to user-delete**

In `src/routes/auth.ts`, the `DELETE /admin/users/:id` handler (around line 813), after the existing `await repo.keyAssignments.deleteByUser(userId)` line and before `await repo.users.delete(userId)`, insert:

```ts
    await repo.observabilityShares.deleteByOwner(userId)
    await repo.observabilityShares.deleteByViewer(userId)
```

- [ ] **Step 2: Add a regression test**

Append to `tests/observability-share-repo.test.ts` (add inside the existing `describe` block):

```ts
  test("cascade: deleteByOwner + deleteByViewer together remove all references to a user", async () => {
    await repo.observabilityShares.share("u-1", "u-2", "u-1")
    await repo.observabilityShares.share("u-1", "u-3", "u-1")
    await repo.observabilityShares.share("u-3", "u-1", "u-3")
    await repo.observabilityShares.deleteByOwner("u-1")
    await repo.observabilityShares.deleteByViewer("u-1")
    expect(await repo.observabilityShares.listByOwner("u-1")).toHaveLength(0)
    expect(await repo.observabilityShares.listByViewer("u-1")).toHaveLength(0)
    // u-3's other relationships untouched
    expect(await repo.observabilityShares.listByOwner("u-3")).toHaveLength(0)
  })
```

- [ ] **Step 3: Run + commit**

Run: `bun test tests/observability-share-repo.test.ts` — expected pass.

```bash
git add src/routes/auth.ts tests/observability-share-repo.test.ts
git commit -m "feat(auth): cascade observability shares on user delete"
```

---

### Task 5: Add `authKind` to `authCheck`

**Files:**
- Modify: `src/index.ts:232-331` (`authCheck` function — every return statement)

- [ ] **Step 1: Add `authKind` to every `authCheck` return**

`authKind` is `'public' | 'admin' | 'session' | 'apiKey'`. Map current branches:
- `PUBLIC_GET_PATHS` / `AUTH_VALIDATE_PATHS` / Google-auth public paths / `/auth/...` no-key path → `'public'`
- ADMIN_KEY match → `'admin'`
- session token (`ses_` prefix) match → `'session'`
- `validateApiKey` match → `'apiKey'`
- Failed/unknown branches that currently return the empty object → `'public'`

In `src/index.ts`, edit each return inside `authCheck` (lines 232-331):

```ts
// Public branches (lines 237, 242, 247, 254, 272, 278) — authKind: 'public'
return { authKey: "", isAdmin: false, isUser: false, apiKeyId: undefined, userId: undefined, authKind: 'public' as const }

// ADMIN_KEY branches (lines 259, 290) — authKind: 'admin'
return { authKey: key, isAdmin: true, isUser: false, apiKeyId: undefined, userId: undefined, authKind: 'admin' as const }

// Session branches (lines 269, 311) — authKind: 'session'
return { authKey: key, isAdmin, isUser: true, apiKeyId: undefined, userId: session.userId, authKind: 'session' as const }

// API key branches (lines 276, 327) — authKind: 'apiKey'
return { authKey: key, isAdmin: false, isUser: !!result.ownerId, apiKeyId: result.id, userId: result.ownerId, authKind: 'apiKey' as const }
```

Apply this systematically to all 10 return sites in `authCheck`.

- [ ] **Step 2: Verify type-check passes**

Run: `bun run tsc --noEmit`

Expected: no errors. The `derive` block at line 398 spreads `...auth` which now also forwards `authKind` to all routes.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(auth): expose authKind on auth context"
```

---

### Task 6: `resolveViewContext` middleware + `getOwnedKeyIdsForScope`

**Files:**
- Create: `src/middleware/view-context.ts`
- Create: `tests/view-context.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/view-context.test.ts`:

```ts
import { test, expect, beforeEach, describe } from "bun:test"
import { Elysia } from "elysia"
import { Database } from "bun:sqlite"
import { SqliteRepo } from "../src/repo/sqlite"
import { setRepoForTest, getRepo } from "../src/repo"
import { resolveViewContext, getOwnedKeyIdsForScope } from "../src/middleware/view-context"

let app: Elysia
let repo: SqliteRepo

type AuthCtx = { userId?: string; authKind?: 'public' | 'admin' | 'session' | 'apiKey' }

beforeEach(async () => {
  repo = new SqliteRepo(new Database(":memory:"))
  setRepoForTest(repo as any)
  await repo.users.create({ id: "alice", name: "Alice", email: "a@x", createdAt: new Date().toISOString(), disabled: false })
  await repo.users.create({ id: "bob",   name: "Bob",   email: "b@x", createdAt: new Date().toISOString(), disabled: false })

  app = new Elysia()
    .derive(({ request }) => {
      const raw = request.headers.get("x-test-auth")
      return raw ? (JSON.parse(raw) as AuthCtx) : ({} as AuthCtx)
    })
    .use(resolveViewContext)
    .get("/probe", ({ effectiveUserId, isViewingShared }) => ({ effectiveUserId, isViewingShared }))
})

async function probe(auth: AuthCtx, asUser?: string) {
  const url = asUser ? `/probe?as_user=${asUser}` : "/probe"
  return app.handle(new Request(`http://x${url}`, { headers: { "x-test-auth": JSON.stringify(auth) } }))
}

describe("resolveViewContext", () => {
  test("no as_user → effective = caller, not shared", async () => {
    const r = await probe({ userId: "alice", authKind: "session" })
    expect(await r.json()).toEqual({ effectiveUserId: "alice", isViewingShared: false })
  })

  test("as_user = self → effective = caller, not shared", async () => {
    const r = await probe({ userId: "alice", authKind: "session" }, "alice")
    expect(await r.json()).toEqual({ effectiveUserId: "alice", isViewingShared: false })
  })

  test("as_user without grant (session auth) → 403", async () => {
    const r = await probe({ userId: "bob", authKind: "session" }, "alice")
    expect(r.status).toBe(403)
  })

  test("as_user with grant (session auth) → effective = owner, shared = true", async () => {
    await repo.observabilityShares.share("alice", "bob", "alice")
    const r = await probe({ userId: "bob", authKind: "session" }, "alice")
    expect(await r.json()).toEqual({ effectiveUserId: "alice", isViewingShared: true })
  })

  test("as_user with API key auth → IGNORED (effective = caller)", async () => {
    await repo.observabilityShares.share("alice", "bob", "alice")
    const r = await probe({ userId: "bob", authKind: "apiKey" }, "alice")
    expect(await r.json()).toEqual({ effectiveUserId: "bob", isViewingShared: false })
  })

  test("as_user with admin auth → IGNORED", async () => {
    await repo.observabilityShares.share("alice", "bob", "alice")
    const r = await probe({ userId: "bob", authKind: "admin" }, "alice")
    expect((await r.json()).effectiveUserId).toBe("bob")
  })
})

describe("getOwnedKeyIdsForScope", () => {
  test("returns only owned keys, excludes assigned ones (no transitive grants)", async () => {
    const { createApiKey } = await import("../src/lib/api-keys")
    await repo.users.create({ id: "carol", name: "Carol", email: "c@x", createdAt: new Date().toISOString(), disabled: false })
    const aliceKey = await createApiKey("alice-key", "alice")
    const carolKey = await createApiKey("carol-key", "carol")
    // Carol assigns her key to Alice (Alice is now both owner of aliceKey + assignee of carolKey)
    await repo.keyAssignments.assign(carolKey.id, "alice", "carol")

    const ids = await getOwnedKeyIdsForScope("alice")
    expect(ids).toEqual([aliceKey.id])
    expect(ids).not.toContain(carolKey.id)
  })

  test("empty when user owns no keys", async () => {
    expect(await getOwnedKeyIdsForScope("bob")).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/view-context.test.ts`

Expected: fails — module `src/middleware/view-context.ts` does not exist.

- [ ] **Step 3: Implement `view-context.ts`**

Create `src/middleware/view-context.ts`:

```ts
import { Elysia } from "elysia"
import { getRepo } from "~/repo"

/**
 * Elysia plugin: derives `effectiveUserId` and `isViewingShared` from
 *   - the auth context (`userId`, `authKind`) already provided by the global derive
 *   - the optional `?as_user=<ownerId>` query parameter
 *
 * `as_user` is honored ONLY for session (cookie) auth and ONLY when the owner
 * has actually granted observability access to the caller. Otherwise the
 * parameter is silently ignored (or rejected with 403 when explicit).
 */
export const resolveViewContext = new Elysia({ name: "resolve-view-context" })
  .derive(async (ctx) => {
    const { query } = ctx
    const auth = ctx as unknown as { userId?: string; authKind?: 'public' | 'admin' | 'session' | 'apiKey' }
    const asUser = (query as Record<string, string | undefined>).as_user

    const callerId = auth.userId
    if (!callerId) {
      return { effectiveUserId: undefined as string | undefined, isViewingShared: false, ownerId: undefined as string | undefined }
    }

    if (!asUser || asUser === callerId || auth.authKind !== 'session') {
      return { effectiveUserId: callerId, isViewingShared: false, ownerId: undefined as string | undefined }
    }

    const granted = await getRepo().observabilityShares.isGranted(asUser, callerId)
    if (!granted) {
      ctx.set.status = 403
      throw new Error("Not authorized to view this user's observability data")
    }
    return { effectiveUserId: asUser, isViewingShared: true, ownerId: asUser }
  })

/**
 * Owned-only key scoping for shared mode.
 *
 * Returns ONLY the keys whose `ownerId === userId`. Excludes keys assigned to
 * `userId` via KeyAssignment so that a viewer who has been granted observability
 * on `userId` does not transitively see keys other people shared with `userId`.
 */
export async function getOwnedKeyIdsForScope(userId: string): Promise<string[]> {
  const repo = getRepo()
  const owned = await repo.apiKeys.listByOwner(userId)
  return owned.map(k => k.id)
}
```

- [ ] **Step 4: Verify pass**

Run: `bun test tests/view-context.test.ts`

Expected: 8/8 pass.

- [ ] **Step 5: Commit**

```bash
git add src/middleware/view-context.ts tests/view-context.test.ts
git commit -m "feat(middleware): resolveViewContext + owned-only scoping"
```

---

### Task 7: `redactForSharedView` + HMAC surrogates

**Files:**
- Create: `src/lib/redact-shared-view.ts`
- Create: `tests/redact-shared-view.test.ts`
- Modify: `src/local.ts` and `src/index.ts` env handling — surrogates need a `SERVER_SECRET`

- [ ] **Step 1: Write the failing test**

Create `tests/redact-shared-view.test.ts`:

```ts
import { test, expect, describe } from "bun:test"
import { sharedKeyRef, sharedAccountRef, sharedRelayRef, redactForSharedView } from "../src/lib/redact-shared-view"

const SECRET = "test-secret-do-not-use-in-prod"

describe("HMAC surrogates", () => {
  test("sharedKeyRef is deterministic per (owner, realId)", () => {
    expect(sharedKeyRef("owner-1", "key-abc", SECRET)).toBe(sharedKeyRef("owner-1", "key-abc", SECRET))
  })

  test("different owners with same realId → different surrogates (no cross-owner correlation)", () => {
    expect(sharedKeyRef("owner-1", "key-abc", SECRET)).not.toBe(sharedKeyRef("owner-2", "key-abc", SECRET))
  })

  test("different kinds with same inputs → different surrogates", () => {
    expect(sharedKeyRef("o", "x", SECRET)).not.toBe(sharedAccountRef("o", "x", SECRET))
    expect(sharedAccountRef("o", "x", SECRET)).not.toBe(sharedRelayRef("o", "x", SECRET))
  })

  test("surrogate is base64url, length 16, no = padding", () => {
    const s = sharedKeyRef("owner-1", "key-abc", SECRET)
    expect(s).toMatch(/^[A-Za-z0-9_-]{16}$/)
  })

  test("rotating the secret changes the surrogate", () => {
    expect(sharedKeyRef("owner-1", "key-abc", "secret-A")).not.toBe(sharedKeyRef("owner-1", "key-abc", "secret-B"))
  })
})

describe("redactForSharedView — token usage records", () => {
  test("replaces keyId with sharedKeyRef, keeps keyName + metrics", () => {
    const records = [
      { keyId: "key-abc", keyName: "My Key", inputTokens: 100, outputTokens: 50, hour: "2026-04-23T10" },
    ]
    const out = redactForSharedView({ kind: "tokenUsage", payload: records, ownerId: "owner-1", secret: SECRET })
    expect(out[0].keyId).toBe(sharedKeyRef("owner-1", "key-abc", SECRET))
    expect(out[0].keyName).toBe("My Key")
    expect(out[0].inputTokens).toBe(100)
    expect(out[0].outputTokens).toBe(50)
  })
})

describe("redactForSharedView — upstream accounts", () => {
  test("replaces id with sharedAccountRef; strips access_token / refresh_token / scopes", () => {
    const accounts = [{
      id: "acct-1",
      login: "octocat",
      avatar_url: "https://x/a.png",
      active: true,
      token_valid: true,
      access_token: "ghp_secret",
      refresh_token: "ghr_secret",
      scopes: ["repo", "read:user"],
      quota: { remaining: 1000 },
    }]
    const out = redactForSharedView({ kind: "upstreamAccounts", payload: accounts, ownerId: "owner-1", secret: SECRET })
    expect(out[0].id).toBe(sharedAccountRef("owner-1", "acct-1", SECRET))
    expect(out[0].login).toBe("octocat")
    expect(out[0].avatar_url).toBe("https://x/a.png")
    expect(out[0].active).toBe(true)
    expect(out[0].token_valid).toBe(true)
    expect(out[0].quota).toEqual({ remaining: 1000 })
    expect((out[0] as any).access_token).toBeUndefined()
    expect((out[0] as any).refresh_token).toBeUndefined()
    expect((out[0] as any).scopes).toBeUndefined()
  })
})

describe("redactForSharedView — relays", () => {
  test("replaces clientId with sharedRelayRef; strips clientName/hostname/IP/gatewayUrl", () => {
    const relays = [{
      clientId: "rly-9",
      clientName: "laptop@host (1.2.3.4)",
      hostname: "host.local",
      gatewayUrl: "https://gw.local",
      keyId: "key-abc",
      keyName: "My Key",
      ownerId: "owner-1",
      lastSeenAt: "2026-04-23T10:00:00Z",
      isOnline: true,
      isActive: false,
    }]
    const out = redactForSharedView({ kind: "relays", payload: relays, ownerId: "owner-1", secret: SECRET })
    expect(out[0].id).toBe(sharedRelayRef("owner-1", "rly-9", SECRET))
    expect(out[0].clientLabel).toBe("My Key")
    expect(out[0].lastSeenAt).toBe("2026-04-23T10:00:00Z")
    expect(out[0].isOnline).toBe(true)
    expect((out[0] as any).clientName).toBeUndefined()
    expect((out[0] as any).hostname).toBeUndefined()
    expect((out[0] as any).gatewayUrl).toBeUndefined()
    expect((out[0] as any).keyId).toBeUndefined()
    expect((out[0] as any).ownerId).toBeUndefined()
  })

  test("clientLabel falls back to 'Relay #N' when keyName missing", () => {
    const relays = [
      { clientId: "rly-1", lastSeenAt: "t", isOnline: true, isActive: false },
      { clientId: "rly-2", lastSeenAt: "t", isOnline: true, isActive: false },
    ]
    const out = redactForSharedView({ kind: "relays", payload: relays, ownerId: "owner-1", secret: SECRET })
    expect(out[0].clientLabel).toBe("Relay #1")
    expect(out[1].clientLabel).toBe("Relay #2")
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `bun test tests/redact-shared-view.test.ts`

Expected: fails — module not found.

- [ ] **Step 3: Implement `redact-shared-view.ts`**

Create `src/lib/redact-shared-view.ts`:

```ts
import { createHmac } from "node:crypto"

function surrogate(secret: string, ownerId: string, kind: string, realId: string): string {
  const h = createHmac("sha256", secret)
  h.update(`${ownerId}:${kind}:${realId}`)
  // base64url, drop padding, take first 16 chars
  return h.digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 16)
}

export function sharedKeyRef(ownerId: string, keyId: string, secret: string): string {
  return surrogate(secret, ownerId, "key", keyId)
}
export function sharedAccountRef(ownerId: string, accountId: string, secret: string): string {
  return surrogate(secret, ownerId, "account", accountId)
}
export function sharedRelayRef(ownerId: string, clientId: string, secret: string): string {
  return surrogate(secret, ownerId, "relay", clientId)
}

type RedactInput =
  | { kind: "tokenUsage"; payload: any[]; ownerId: string; secret: string }
  | { kind: "latency"; payload: any[]; ownerId: string; secret: string }
  | { kind: "upstreamAccounts"; payload: any[]; ownerId: string; secret: string }
  | { kind: "relays"; payload: any[]; ownerId: string; secret: string }

export function redactForSharedView(input: RedactInput): any[] {
  const { ownerId, secret } = input
  switch (input.kind) {
    case "tokenUsage":
    case "latency":
      return input.payload.map((r: any) => ({
        ...r,
        keyId: sharedKeyRef(ownerId, r.keyId, secret),
      }))
    case "upstreamAccounts":
      return input.payload.map((a: any) => ({
        id: sharedAccountRef(ownerId, String(a.id), secret),
        login: a.login,
        avatar_url: a.avatar_url,
        active: a.active,
        token_valid: a.token_valid,
        quota: a.quota,
      }))
    case "relays":
      return input.payload.map((c: any, idx: number) => ({
        id: sharedRelayRef(ownerId, c.clientId, secret),
        clientLabel: c.keyName || `Relay #${idx + 1}`,
        status: c.isOnline ? "connected" : "disconnected",
        isOnline: c.isOnline,
        isActive: c.isActive,
        lastSeenAt: c.lastSeenAt,
      }))
  }
}

/** Read SERVER_SECRET from env or fall back to a deterministic dev value. */
export function getServerSecret(env: Record<string, string | undefined>): string {
  return env.SERVER_SECRET || env.ADMIN_KEY || "dev-server-secret-change-me"
}
```

- [ ] **Step 4: Verify pass**

Run: `bun test tests/redact-shared-view.test.ts`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/redact-shared-view.ts tests/redact-shared-view.test.ts
git commit -m "feat(lib): redactForSharedView + HMAC surrogates"
```

---

### Task 8: Refactor observability routes to honor `effectiveUserId` + redact

**Files:**
- Modify: `src/routes/dashboard.ts:25-54` (helpers), `:57-82` (`/copilot-quota`), `:129-189` (`/token-usage`), `:192-230` (`/latency`), `:370-421` (`/relays`)
- Modify: `src/index.ts:404-406` to mount `dashboardRoute` AFTER `resolveViewContext`
- Create: `tests/observability-share-integration.test.ts`

- [ ] **Step 1: Write failing integration tests**

Create `tests/observability-share-integration.test.ts`:

```ts
import { test, expect, beforeEach, describe } from "bun:test"
import { Elysia } from "elysia"
import { Database } from "bun:sqlite"
import { SqliteRepo } from "../src/repo/sqlite"
import { setRepoForTest } from "../src/repo"
import { createApiKey } from "../src/lib/api-keys"
import { resolveViewContext } from "../src/middleware/view-context"
import { dashboardRoute } from "../src/routes/dashboard"
import { sharedKeyRef } from "../src/lib/redact-shared-view"

const SECRET = "dev-server-secret-change-me"

let app: Elysia
let repo: SqliteRepo
let aliceKeyId: string

beforeEach(async () => {
  process.env.SERVER_SECRET = SECRET
  repo = new SqliteRepo(new Database(":memory:"))
  setRepoForTest(repo as any)
  await repo.users.create({ id: "alice", name: "Alice", email: "a@x", createdAt: new Date().toISOString(), disabled: false })
  await repo.users.create({ id: "bob",   name: "Bob",   email: "b@x", createdAt: new Date().toISOString(), disabled: false })
  await repo.users.create({ id: "carol", name: "Carol", email: "c@x", createdAt: new Date().toISOString(), disabled: false })

  const ak = await createApiKey("alice-key", "alice")
  aliceKeyId = ak.id
  const ck = await createApiKey("carol-key", "carol")
  // Carol assigns her key to Alice
  await repo.keyAssignments.assign(ck.id, "alice", "carol")

  // Seed token usage on alice's key + carol's key
  await repo.usage.set({ keyId: aliceKeyId, model: "gpt-x", hour: "2026-04-23T10", inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0, count: 1, client: null })
  await repo.usage.set({ keyId: ck.id,    model: "gpt-x", hour: "2026-04-23T10", inputTokens: 999, outputTokens: 999, cacheReadTokens: 0, cacheCreationTokens: 0, count: 1, client: null })

  app = new Elysia()
    .derive(({ request }) => {
      const raw = request.headers.get("x-test-auth")
      return raw ? JSON.parse(raw) : {}
    })
    .use(resolveViewContext)
    .use(dashboardRoute)
})

async function call(auth: any, path: string) {
  return app.handle(new Request(`http://x${path}`, { headers: { "x-test-auth": JSON.stringify(auth) } }))
}

describe("/api/token-usage shared mode", () => {
  test("viewer with grant sees owner's owned-only data with surrogate keyIds", async () => {
    await repo.observabilityShares.share("alice", "bob", "alice")
    const r = await call({ userId: "bob", authKind: "session" }, "/api/token-usage?as_user=alice&start=2026-04-23T00&end=2026-04-23T23")
    expect(r.status).toBe(200)
    const body = await r.json()
    // Returns alice's owned key only — NOT carol's assigned key
    const keyIds = new Set(body.records.map((rec: any) => rec.keyId))
    expect(keyIds.has(sharedKeyRef("alice", aliceKeyId, SECRET))).toBe(true)
    // No raw UUIDs leak
    expect(keyIds.has(aliceKeyId)).toBe(false)
  })

  test("viewer without grant gets 403", async () => {
    const r = await call({ userId: "bob", authKind: "session" }, "/api/token-usage?as_user=alice&start=2026-04-23T00&end=2026-04-23T23")
    expect(r.status).toBe(403)
  })

  test("API-key auth ignores as_user", async () => {
    await repo.observabilityShares.share("alice", "bob", "alice")
    const r = await call({ userId: "bob", authKind: "apiKey" }, "/api/token-usage?as_user=alice&start=2026-04-23T00&end=2026-04-23T23")
    expect(r.status).toBe(200)
    const body = await r.json()
    // Bob has no keys; result should be empty for him
    expect(body.records).toEqual([])
  })
})

describe("/api/latency shared mode", () => {
  test("viewer sees owner's owned-only latency with surrogate keyIds", async () => {
    await repo.latency.record({ keyId: aliceKeyId, model: "gpt-x", latencyMs: 250, ttftMs: 50, ts: "2026-04-23T10:00:00Z" })
    await repo.observabilityShares.share("alice", "bob", "alice")
    const r = await call({ userId: "bob", authKind: "session" }, "/api/latency?as_user=alice&start=2026-04-23T00&end=2026-04-23T23")
    expect(r.status).toBe(200)
    const body = await r.json()
    const ids = new Set(body.map((rec: any) => rec.keyId))
    expect(ids.has(sharedKeyRef("alice", aliceKeyId, SECRET))).toBe(true)
    expect(ids.has(aliceKeyId)).toBe(false)
  })
})

describe("/api/relays shared mode", () => {
  test("viewer sees owner's relays with surrogate ids; hostname/IP/url stripped", async () => {
    await repo.presence.upsert({
      clientId: "rly-1",
      clientName: "laptop@host (1.2.3.4)",
      keyId: aliceKeyId,
      keyName: "alice-key",
      ownerId: "alice",
      gatewayUrl: "https://gw.local",
      lastSeenAt: new Date().toISOString(),
    })
    await repo.observabilityShares.share("alice", "bob", "alice")
    const r = await call({ userId: "bob", authKind: "session" }, "/api/relays?as_user=alice")
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body[0].id).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect(body[0].clientLabel).toBeDefined()
    expect(body[0].clientName).toBeUndefined()
    expect(body[0].hostname).toBeUndefined()
    expect(body[0].gatewayUrl).toBeUndefined()
    expect(body[0].keyId).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run failing**

Run: `bun test tests/observability-share-integration.test.ts`

Expected: failures — handlers don't yet branch on `effectiveUserId` / `isViewingShared`, and dashboardRoute can't see those derived fields.

- [ ] **Step 3: Refactor `dashboardRoute` to use derived view context**

In `src/index.ts`, the route mount section (lines 404-406):

```ts
    .use(authRoute)
    .use(apiKeysRoute)
    .use(resolveViewContext)
    .use(dashboardRoute)
```

In `src/routes/dashboard.ts`, extend `AuthCtx` (line 7-12):

```ts
interface AuthCtx {
  isAdmin?: boolean
  isUser?: boolean
  userId?: string
  apiKeyId?: string
  effectiveUserId?: string
  isViewingShared?: boolean
  ownerId?: string
}
```

Add imports at top of file:

```ts
import { redactForSharedView, getServerSecret } from "~/lib/redact-shared-view"
import { getOwnedKeyIdsForScope } from "~/middleware/view-context"
```

- [ ] **Step 4: Update `/copilot-quota`**

Replace the body of the `/copilot-quota` handler (lines 58-82). Use `effectiveUserId` for the `getGithubCredentials(...)` call. The response shape is GitHub's quota JSON; in shared mode, return as-is (it does not contain key plaintext or OAuth tokens — only plan/quota figures, which are explicitly allowed per spec §2.3).

```ts
  .get("/copilot-quota", async (ctx) => {
    const { effectiveUserId, userId } = ctx as unknown as AuthCtx
    const target = effectiveUserId ?? userId
    try {
      const { token: githubToken } = await getGithubCredentials(target)
      const resp = await fetch("https://api.github.com/copilot_internal/user", {
        headers: createGithubHeaders(githubToken),
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

- [ ] **Step 5: Update `/token-usage`**

In the `/token-usage` handler (lines 129-189), in the user branch (`else if (userId)`), add a shared-mode branch ahead of it:

```ts
    } else if (isViewingShared && ownerId) {
      const ids = await getOwnedKeyIdsForScope(ownerId)
      if (ids.length === 0) return { records: [], filters: { keys: [] } }
      const ownedKeys = await repo.apiKeys.listByOwner(ownerId)
      const records = await repo.usage.query({ keyIds: ids, start, end /* + existing filters */ })
      const enriched = records.map(r => ({ ...r, keyName: ownedKeys.find(k => k.id === r.keyId)?.name }))
      const redacted = redactForSharedView({ kind: "tokenUsage", payload: enriched, ownerId, secret: getServerSecret(process.env) })
      const filters = {
        keys: ownedKeys.map(k => ({ keyId: redacted.find(r => r.keyName === k.name)?.keyId, keyName: k.name })),
      }
      return { records: redacted, filters }
    } else if (userId) {
      // existing code unchanged — self mode keeps assigned-key inclusion
```

(If the existing handler returns shapes other than `{records, filters}`, mirror those exact shapes — read the current handler carefully and apply redaction at the response edge so the schema is preserved.)

- [ ] **Step 6: Update `/latency`**

In `/latency` (lines 192-230), insert before the `else if (userId)` branch:

```ts
    } else if (isViewingShared && ownerId) {
      const ids = await getOwnedKeyIdsForScope(ownerId)
      if (ids.length === 0) return []
      const ownedKeys = await repo.apiKeys.listByOwner(ownerId)
      const records = await repo.latency.query({ keyIds: ids, start, end })
      const nameMap = new Map(ownedKeys.map(k => [k.id, k.name]))
      const enriched = records.map(r => ({ ...r, keyName: nameMap.get(r.keyId) ?? r.keyId.slice(0, 8) }))
      return redactForSharedView({ kind: "latency", payload: enriched, ownerId, secret: getServerSecret(process.env) })
    }
```

Replace the destructure `const { isAdmin, userId } = ctx as unknown as AuthCtx` with `const { isAdmin, userId, isViewingShared, ownerId } = ctx as unknown as AuthCtx`.

- [ ] **Step 7: Update `/relays`**

In `/relays` (lines 372-421), add a shared branch ahead of `else if (userId)`:

```ts
    if (isViewingShared && ownerId) {
      const ownedKeyIds = await getOwnedKeyIdsForScope(ownerId)
      if (ownedKeyIds.length === 0) return []
      const clients = await repo.presence.listByKeyIds(ownedKeyIds)
      const now = Date.now()
      const onlineThresholdMinutes = 3
      const enriched = clients.map(c => ({
        ...c,
        isOnline: now - new Date(c.lastSeenAt).getTime() < onlineThresholdMinutes * 60 * 1000,
        isActive: false,
      }))
      return redactForSharedView({ kind: "relays", payload: enriched, ownerId, secret: getServerSecret(process.env) })
    }
```

Update destructure to include `isViewingShared, ownerId`.

- [ ] **Step 8: Verify integration tests pass**

Run: `bun test tests/observability-share-integration.test.ts`

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/index.ts src/routes/dashboard.ts tests/observability-share-integration.test.ts
git commit -m "feat(routes): honor effectiveUserId + redact in shared mode"
```

---

### Task 9: New `/api/upstream-accounts` route + trim `/auth/me`

**Files:**
- Create: `src/routes/upstream-accounts.ts`
- Modify: `src/routes/auth.ts:575-...` (`/auth/me` accounts portion — remove the per-account fanout)
- Modify: `src/index.ts` to mount the new route under `resolveViewContext`
- Append to: `tests/observability-share-integration.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/observability-share-integration.test.ts`:

```ts
import { upstreamAccountsRoute } from "../src/routes/upstream-accounts"

describe("/api/upstream-accounts", () => {
  test("self-mode returns full owner-visible accounts (real id, no oauth tokens)", async () => {
    await repo.github.saveAccount("alice", {
      user: { id: 12345, login: "alicegh", avatar_url: "https://x/a.png" },
      access_token: "ghp_xxx",
      refresh_token: "ghr_xxx",
      scopes: ["repo"],
      ownerId: "alice",
    } as any)
    const local = new Elysia()
      .derive(({ request }) => JSON.parse(request.headers.get("x-test-auth") || "{}"))
      .use(resolveViewContext)
      .use(upstreamAccountsRoute)
    const r = await local.handle(new Request("http://x/api/upstream-accounts", {
      headers: { "x-test-auth": JSON.stringify({ userId: "alice", authKind: "session" }) },
    }))
    const body = await r.json()
    expect(body[0].login).toBe("alicegh")
    expect(body[0].access_token).toBeUndefined()  // self mode also strips OAuth tokens from JSON response
  })

  test("shared-mode returns surrogate id, strips OAuth tokens", async () => {
    await repo.github.saveAccount("alice", {
      user: { id: 12345, login: "alicegh", avatar_url: "https://x/a.png" },
      access_token: "ghp_xxx",
      refresh_token: "ghr_xxx",
      scopes: ["repo"],
      ownerId: "alice",
    } as any)
    await repo.observabilityShares.share("alice", "bob", "alice")
    const local = new Elysia()
      .derive(({ request }) => JSON.parse(request.headers.get("x-test-auth") || "{}"))
      .use(resolveViewContext)
      .use(upstreamAccountsRoute)
    const r = await local.handle(new Request("http://x/api/upstream-accounts?as_user=alice", {
      headers: { "x-test-auth": JSON.stringify({ userId: "bob", authKind: "session" }) },
    }))
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body[0].id).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect(body[0].id).not.toBe("12345")
    expect(body[0].login).toBe("alicegh")
    expect(body[0].access_token).toBeUndefined()
    expect(body[0].refresh_token).toBeUndefined()
    expect(body[0].scopes).toBeUndefined()
  })
})
```

- [ ] **Step 2: Implement `upstream-accounts.ts`**

Create `src/routes/upstream-accounts.ts`:

```ts
import { Elysia } from "elysia"
import { getRepo } from "~/repo"
import { redactForSharedView, getServerSecret } from "~/lib/redact-shared-view"
import { fetchCopilotQuota } from "~/lib/quota"

interface ViewCtx {
  userId?: string
  effectiveUserId?: string
  isViewingShared?: boolean
  ownerId?: string
}

export const upstreamAccountsRoute = new Elysia()
  .get("/api/upstream-accounts", async (ctx) => {
    const { effectiveUserId, isViewingShared, ownerId, userId } = ctx as unknown as ViewCtx
    const target = effectiveUserId ?? userId
    if (!target) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } })
    }

    const repo = getRepo()
    const accounts = await repo.github.listAccountsByOwner(target)

    // Build the self-mode shape the existing upstream tab uses.
    const enriched = await Promise.all(accounts.map(async (a: any) => {
      let quota: any = null
      try { quota = await fetchCopilotQuota(a.access_token) } catch { /* noop */ }
      return {
        id: String(a.user?.id ?? a.id),
        login: a.user?.login,
        avatar_url: a.user?.avatar_url,
        active: !!a.active,
        token_valid: !!a.token_valid,
        quota,
      }
    }))

    if (isViewingShared && ownerId) {
      return redactForSharedView({ kind: "upstreamAccounts", payload: enriched, ownerId, secret: getServerSecret(process.env) })
    }
    return enriched
  })
```

> Note: `fetchCopilotQuota` and `repo.github.listAccountsByOwner` may not exist yet under those exact names. The existing implementation lives inside `/auth/me` — port the same logic. If a helper name differs, use the actual one from the codebase. Do NOT introduce new helper modules; reuse what `/auth/me` already calls.

- [ ] **Step 3: Mount in `src/index.ts`**

In `src/index.ts`, after the `dashboardRoute` mount (line 406):

```ts
    .use(upstreamAccountsRoute)
```

(import at top: `import { upstreamAccountsRoute } from "./routes/upstream-accounts"`)

- [ ] **Step 4: Trim `/auth/me`**

In `src/routes/auth.ts`, the `/auth/me` handler (around line 575):
- Keep returning identity fields (`id`, `email`, `name`, `avatarUrl`, etc.)
- Remove the per-account fanout / quota population from the response (frontend will call `/api/upstream-accounts` instead). If the existing payload includes `accounts`, leave the field but as an empty array — or remove it entirely if no consumer depends on it.
- `/auth/me` MUST NOT honor `as_user` (do not pass `effectiveUserId`; always use the caller's session userId).

- [ ] **Step 5: Verify pass**

Run: `bun test tests/observability-share-integration.test.ts`

Expected: all pass (including the new `/api/upstream-accounts` cases).

- [ ] **Step 6: Commit**

```bash
git add src/routes/upstream-accounts.ts src/routes/auth.ts src/index.ts tests/observability-share-integration.test.ts
git commit -m "feat(routes): /api/upstream-accounts (extracted from /auth/me)"
```

---

### Task 10: Share-management routes (`/api/observability-shares*`)

**Files:**
- Create: `src/routes/observability-shares.ts`
- Modify: `src/index.ts` — mount route
- Create: `tests/observability-share-routes.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/observability-share-routes.test.ts`:

```ts
import { test, expect, beforeEach, describe } from "bun:test"
import { Elysia } from "elysia"
import { Database } from "bun:sqlite"
import { SqliteRepo } from "../src/repo/sqlite"
import { setRepoForTest } from "../src/repo"
import { observabilitySharesRoute } from "../src/routes/observability-shares"

let app: Elysia
let repo: SqliteRepo

beforeEach(async () => {
  repo = new SqliteRepo(new Database(":memory:"))
  setRepoForTest(repo as any)
  await repo.users.create({ id: "u-alice", name: "Alice", email: "alice@x", createdAt: new Date().toISOString(), disabled: false })
  await repo.users.create({ id: "u-bob",   name: "Bob",   email: "bob@x",   createdAt: new Date().toISOString(), disabled: false })
  app = new Elysia()
    .derive(({ request }) => JSON.parse(request.headers.get("x-test-auth") || "{}"))
    .use(observabilitySharesRoute)
})

async function call(auth: any, method: string, path: string, body?: unknown) {
  const init: RequestInit = { method, headers: { "x-test-auth": JSON.stringify(auth), "Content-Type": "application/json" } }
  if (body !== undefined) init.body = JSON.stringify(body)
  return app.handle(new Request(`http://x${path}`, init))
}

describe("POST /api/observability-shares", () => {
  test("grants by viewer email", async () => {
    const r = await call({ userId: "u-alice", authKind: "session" }, "POST", "/api/observability-shares", { viewerEmail: "bob@x" })
    expect(r.status).toBe(200)
    expect(await repo.observabilityShares.isGranted("u-alice", "u-bob")).toBe(true)
  })

  test("self-grant returns 400", async () => {
    const r = await call({ userId: "u-alice", authKind: "session" }, "POST", "/api/observability-shares", { viewerEmail: "alice@x" })
    expect(r.status).toBe(400)
  })

  test("unknown email returns 404", async () => {
    const r = await call({ userId: "u-alice", authKind: "session" }, "POST", "/api/observability-shares", { viewerEmail: "ghost@x" })
    expect(r.status).toBe(404)
  })

  test("duplicate grant is idempotent (200)", async () => {
    await call({ userId: "u-alice", authKind: "session" }, "POST", "/api/observability-shares", { viewerEmail: "bob@x" })
    const r = await call({ userId: "u-alice", authKind: "session" }, "POST", "/api/observability-shares", { viewerEmail: "bob@x" })
    expect(r.status).toBe(200)
    const list = await repo.observabilityShares.listByOwner("u-alice")
    expect(list).toHaveLength(1)
  })

  test("non-session auth is rejected", async () => {
    const r = await call({ userId: "u-alice", authKind: "apiKey" }, "POST", "/api/observability-shares", { viewerEmail: "bob@x" })
    expect(r.status).toBe(403)
  })

  test("ignores as_user (managing own shares is self-op)", async () => {
    const r = await call({ userId: "u-alice", authKind: "session" }, "POST", "/api/observability-shares?as_user=u-bob", { viewerEmail: "bob@x" })
    expect(r.status).toBe(200)
    expect(await repo.observabilityShares.isGranted("u-alice", "u-bob")).toBe(true)
    expect(await repo.observabilityShares.isGranted("u-bob", "u-bob")).toBe(false)
  })
})

describe("DELETE /api/observability-shares/:viewerId", () => {
  test("revokes the grant", async () => {
    await repo.observabilityShares.share("u-alice", "u-bob", "u-alice")
    const r = await call({ userId: "u-alice", authKind: "session" }, "DELETE", "/api/observability-shares/u-bob")
    expect(r.status).toBe(200)
    expect(await repo.observabilityShares.isGranted("u-alice", "u-bob")).toBe(false)
  })
})

describe("GET /api/observability-shares/granted-by-me", () => {
  test("returns enriched viewer records", async () => {
    await repo.observabilityShares.share("u-alice", "u-bob", "u-alice")
    const r = await call({ userId: "u-alice", authKind: "session" }, "GET", "/api/observability-shares/granted-by-me")
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body[0]).toMatchObject({ viewerId: "u-bob", viewerEmail: "bob@x", viewerName: "Bob" })
  })
})

describe("GET /api/observability-shares/granted-to-me", () => {
  test("returns enriched owner records", async () => {
    await repo.observabilityShares.share("u-alice", "u-bob", "u-alice")
    const r = await call({ userId: "u-bob", authKind: "session" }, "GET", "/api/observability-shares/granted-to-me")
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body[0]).toMatchObject({ ownerId: "u-alice", ownerEmail: "alice@x", ownerName: "Alice" })
  })
})
```

- [ ] **Step 2: Run failing**

Run: `bun test tests/observability-share-routes.test.ts`

Expected: all fail — module missing.

- [ ] **Step 3: Implement the route**

Create `src/routes/observability-shares.ts`:

```ts
import { Elysia } from "elysia"
import { getRepo } from "~/repo"

interface AuthCtx {
  userId?: string
  authKind?: 'public' | 'admin' | 'session' | 'apiKey'
}

function unauthorized() {
  return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { "Content-Type": "application/json" } })
}

function badRequest(msg: string) {
  return new Response(JSON.stringify({ error: msg }), { status: 400, headers: { "Content-Type": "application/json" } })
}

function notFound(msg: string) {
  return new Response(JSON.stringify({ error: msg }), { status: 404, headers: { "Content-Type": "application/json" } })
}

export const observabilitySharesRoute = new Elysia()
  .post("/api/observability-shares", async (ctx) => {
    const { userId, authKind } = ctx as unknown as AuthCtx
    if (authKind !== 'session' || !userId) return unauthorized()
    const { viewerEmail } = (ctx.body ?? {}) as { viewerEmail?: string }
    if (!viewerEmail) return badRequest("viewerEmail is required")
    const repo = getRepo()
    const viewer = await repo.users.getByEmail(viewerEmail.toLowerCase())
    if (!viewer) return notFound("viewer email not found")
    if (viewer.id === userId) return badRequest("cannot share with yourself")
    await repo.observabilityShares.share(userId, viewer.id, userId)  // idempotent via INSERT OR REPLACE
    return { ownerId: userId, viewerId: viewer.id, viewerEmail: viewer.email, viewerName: viewer.name }
  })

  .delete("/api/observability-shares/:viewerId", async (ctx) => {
    const { userId, authKind } = ctx as unknown as AuthCtx
    if (authKind !== 'session' || !userId) return unauthorized()
    const { viewerId } = ctx.params as { viewerId: string }
    await getRepo().observabilityShares.unshare(userId, viewerId)
    return { ok: true }
  })

  .get("/api/observability-shares/granted-by-me", async (ctx) => {
    const { userId, authKind } = ctx as unknown as AuthCtx
    if (authKind !== 'session' || !userId) return unauthorized()
    const repo = getRepo()
    const grants = await repo.observabilityShares.listByOwner(userId)
    const viewers = await Promise.all(grants.map(g => repo.users.getById(g.viewerId)))
    return grants.map((g, i) => ({
      viewerId: g.viewerId,
      viewerEmail: viewers[i]?.email,
      viewerName: viewers[i]?.name,
      grantedAt: g.grantedAt,
    }))
  })

  .get("/api/observability-shares/granted-to-me", async (ctx) => {
    const { userId, authKind } = ctx as unknown as AuthCtx
    if (authKind !== 'session' || !userId) return unauthorized()
    const repo = getRepo()
    const grants = await repo.observabilityShares.listByViewer(userId)
    const owners = await Promise.all(grants.map(g => repo.users.getById(g.ownerId)))
    return grants.map((g, i) => ({
      ownerId: g.ownerId,
      ownerEmail: owners[i]?.email,
      ownerName: owners[i]?.name,
      grantedAt: g.grantedAt,
    }))
  })
```

- [ ] **Step 4: Mount in `src/index.ts`**

In `src/index.ts`, after `upstreamAccountsRoute`:

```ts
    .use(observabilitySharesRoute)
```

(import at top: `import { observabilitySharesRoute } from "./routes/observability-shares"`)

- [ ] **Step 5: Verify pass**

Run: `bun test tests/observability-share-routes.test.ts`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/routes/observability-shares.ts src/index.ts tests/observability-share-routes.test.ts
git commit -m "feat(routes): observability-shares management endpoints"
```

---

## Task 11: Frontend — Alpine state, observabilityFetch, boot sequence, hash hardening

**Files:**
- Modify: `src/ui/dashboard/client.ts`
  - State block at line 246 (`tab: initTab,`) — add `viewAs`, `sharedToMe`, `sharedByMe`, `mySharingOpen`
  - `init()` at line 445
  - `loadMe()` at line 639
  - hashchange handler at line 532-535
  - `switchTab(t)` at line 560

- [ ] **Step 1: Add Alpine state fields**

In `src/ui/dashboard/client.ts`, locate the object literal that begins around line 246 (`tab: initTab,`). Immediately after that line (still inside the same object literal returned by `dashboardApp()`), add:

```js
      // — Shared Observability (spec §3.1) —
      viewAs: null,            // null = self; else ownerId being viewed
      sharedToMe: [],          // [{ ownerId, ownerEmail, ownerName }]
      sharedByMe: [],          // [{ viewerId, viewerEmail, viewerName, grantedAt }]
      mySharingOpen: false,    // controls "My Sharing" modal visibility
      mySharingEmail: '',      // email input in modal
      mySharingError: '',      // error string under input
```

- [ ] **Step 2: Add `observabilityFetch` and `switchViewAs` helpers**

Add the following two methods to the same Alpine object, immediately after `tab: initTab,` block (and before `init()`). If unsure where, place them right above `async init()` at line 445:

```js
      // Spec §3.1 — observability paths only. NEVER use this for writes,
      // /auth/me, /api/keys, or /api/observability-shares. Helper choice
      // is the security boundary; there is no central allowlist guard.
      observabilityFetch(path, opts = {}) {
        const url = new URL(path, location.origin)
        if (this.viewAs) url.searchParams.set('as_user', this.viewAs)
        return fetch(url, opts)
      },

      // Spec §3.1.2 — context switch.
      async switchViewAs(ownerId) {
        this.viewAs = ownerId || null
        if (this.viewAs) {
          localStorage.setItem('viewAs', this.viewAs)
          this.keys = []                    // drop stale owner key state
          if (this.tab === 'keys') {
            this.tab = 'usage'
            location.hash = 'usage'
          }
        } else {
          localStorage.removeItem('viewAs')
          await this.loadKeys()             // restore self keys exactly once
        }
        await this.refreshAll()
      },

      // Spec §3.5 — auto-fall-back when grant has been revoked mid-session.
      async fallBackToSelfFromShared(reason) {
        this.viewAs = null
        localStorage.removeItem('viewAs')
        if (typeof this.toast === 'function') {
          this.toast(this.t('dash.sharedObsRevokedToast') || 'Access revoked', 'warn')
        }
        await this.loadKeys()
        await this.refreshAll()
      },

      // Spec §3.1.1 — load grants where current user is the viewer.
      async loadSharedToMe() {
        try {
          const r = await fetch('/api/observability-shares/granted-to-me')
          if (!r.ok) { this.sharedToMe = []; return }
          this.sharedToMe = await r.json()
        } catch (e) {
          console.error('loadSharedToMe:', e)
          this.sharedToMe = []
        }
      },

      // Spec §3.3 — load grants where current user is the owner.
      async loadSharedByMe() {
        try {
          const r = await fetch('/api/observability-shares/granted-by-me')
          if (!r.ok) { this.sharedByMe = []; return }
          this.sharedByMe = await r.json()
        } catch (e) {
          console.error('loadSharedByMe:', e)
          this.sharedByMe = []
        }
      },

      // Modal helpers — share-management writes use plain fetch, never observabilityFetch.
      async addMySharing() {
        this.mySharingError = ''
        const email = (this.mySharingEmail || '').trim().toLowerCase()
        if (!email) { this.mySharingError = this.t('dash.sharedObsAddPlaceholder'); return }
        try {
          const r = await fetch('/api/observability-shares', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ viewerEmail: email }),
          })
          if (r.status === 404) { this.mySharingError = this.t('dash.sharedObsNotFound') || 'No user with that email'; return }
          if (r.status === 400) { this.mySharingError = this.t('dash.sharedObsCannotSelf') || 'Cannot share with yourself'; return }
          if (!r.ok)            { this.mySharingError = 'Failed: ' + r.status; return }
          this.mySharingEmail = ''
          await this.loadSharedByMe()
        } catch (e) { this.mySharingError = String(e) }
      },

      async revokeMySharing(viewerId) {
        try {
          const r = await fetch('/api/observability-shares/' + encodeURIComponent(viewerId), { method: 'DELETE' })
          if (!r.ok) return
          await this.loadSharedByMe()
        } catch (e) { console.error('revokeMySharing:', e) }
      },

      async refreshAll() {
        // Re-trigger every observability panel that the current tab owns.
        // Implementations of these methods are existing; we only re-call them
        // — they will route through observabilityFetch where applicable.
        try { await this.loadCopilotQuota?.() } catch {}
        try { await this.loadTokenUsage?.() } catch {}
        try { await this.loadLatency?.() } catch {}
        try { await this.loadRelays?.() } catch {}
        try { await this.loadUpstreamAccounts?.() } catch {}
      },
```

- [ ] **Step 3: Update boot sequence in `init()`**

Locate `async init()` near line 445. Immediately after the existing `await this.loadMe()` call (around line 495), splice in:

```js
            // Spec §3.1.1 — view-as boot sequence
            await this.loadSharedToMe();
            const stored = localStorage.getItem('viewAs');
            if (stored && this.sharedToMe.some(s => s.ownerId === stored)) {
              this.viewAs = stored;
            } else {
              this.viewAs = null;
              if (stored) localStorage.removeItem('viewAs');
            }
            if (this.viewAs && this.tab === 'keys') {
              this.tab = 'usage';
              location.hash = 'usage';
            }
            // Spec §3.3 — owner-side share list (used by My Sharing modal)
            await this.loadSharedByMe();
```

- [ ] **Step 4: Harden hashchange listener**

Locate the hashchange handler at line 532-535. Replace the `if (this.tab !== h) this.switchTab(h);` line with:

```js
            // Spec §3.5 — Keys tab is forbidden in shared mode
            if (this.viewAs && h === 'keys') {
              this.tab = 'usage';
              location.hash = 'usage';
              return;
            }
            if (this.tab !== h) this.switchTab(h);
```

- [ ] **Step 5: Intercept `switchTab('keys')`**

Locate `async switchTab(t)` at line 560. Add as the **first** statement inside the function body:

```js
          // Spec §3.5 — switchTab('keys') is a no-op while viewing another user
          if (this.viewAs && t === 'keys') return;
```

- [ ] **Step 6: Patch `loadMe()` to refuse stale viewAs after identity loss**

In `loadMe()` (line 639), after the existing `meLoaded = true` (or wherever success is set), add:

```js
              // Spec §3.5 — if signed out / identity lost, drop viewAs
              if (!this.userId && this.viewAs) {
                this.viewAs = null;
                localStorage.removeItem('viewAs');
              }
```

- [ ] **Step 7: Add 403 fallback in `observabilityFetch`**

Replace the `observabilityFetch` body added in Step 2 with the following so 403 from the upstream call drops the view (Spec §3.1.1 last paragraph):

```js
      async observabilityFetch(path, opts = {}) {
        const url = new URL(path, location.origin)
        if (this.viewAs) url.searchParams.set('as_user', this.viewAs)
        const r = await fetch(url, opts)
        if (this.viewAs && r.status === 403) {
          await this.fallBackToSelfFromShared('forbidden')
        }
        return r
      },
```

- [ ] **Step 8: Convert observability panel callers to `observabilityFetch`**

For each existing panel loader, change its `fetch('/api/...')` call to `this.observabilityFetch('/api/...')`. The five paths to convert (and ONLY these):

| Loader method                | Endpoint                  |
|------------------------------|---------------------------|
| `loadCopilotQuota`           | `/api/copilot-quota`      |
| `loadTokenUsage`             | `/api/token-usage`        |
| `loadLatency`                | `/api/latency`            |
| `loadRelays`                 | `/api/relays`             |
| `loadUpstreamAccounts`       | `/api/upstream-accounts`  |

Use Grep to locate each loader (e.g., `grep -n "loadCopilotQuota\|/api/copilot-quota" src/ui/dashboard/client.ts`). For every line of the form:

```js
            const r = await fetch('/api/token-usage' + qs);
```

change it to:

```js
            const r = await this.observabilityFetch('/api/token-usage' + qs);
```

Do **not** alter calls to `/api/keys`, `/auth/me`, `/api/users`, `/admin/...`, `/api/observability-shares`, or any write call.

- [ ] **Step 9: Manual smoke test**

Run: `bun run local`

Open dashboard, sign in as User A, share with User B from the UI (Task 12 will add the modal — for this step verify via cURL):
```bash
curl -X POST http://localhost:3001/api/observability-shares \
  -H 'Content-Type: application/json' --cookie cookies.txt \
  -d '{"viewerEmail":"b@example.com"}'
```

Then sign in as User B, refresh dashboard:
- Header dropdown (added in Task 12) lists User A
- Switching context: token usage, latency, relays panels load A's data; Keys tab disappears
- Manually setting `location.hash = '#keys'` redirects back to `#usage`
- Switching back to "Self" reloads own keys exactly once

Expected: every assertion holds.

- [ ] **Step 10: Commit**

```bash
git add src/ui/dashboard/client.ts
git commit -m "feat(ui): viewAs state, observabilityFetch, boot sequence + hash hardening"
```

---

## Task 12: Frontend — header dropdown, banner, "My Sharing" modal, Keys nav hide, upstream/relay guards

**Files:**
- Modify: `src/ui/dashboard/tabs.ts`
  - User menu around line 46-77
  - Top nav row around line 86-115
  - Upstream account row click handler
  - Relays table column headers/cells

- [ ] **Step 1: Add header view-as dropdown + banner**

In `src/ui/dashboard/tabs.ts`, immediately above the existing `<!-- User menu -->` block (line 46), insert:

```html
        <!-- Shared Observability: viewer dropdown (spec §3.2) -->
        <div x-show="sharedToMe.length > 0" class="hidden sm:flex items-center mr-3">
          <select class="text-xs sm:text-sm rounded-md bg-surface-700 text-themed border border-themed-border px-2 py-1"
                  @change="switchViewAs($event.target.value || null)">
            <option :value="''" :selected="!viewAs" x-text="t('dash.viewAsSelf')"></option>
            <template x-for="s in sharedToMe" :key="s.ownerId">
              <option :value="s.ownerId" :selected="viewAs === s.ownerId"
                      x-text="t('dash.viewAsOwner', { name: s.ownerName || s.ownerEmail })"></option>
            </template>
          </select>
        </div>
```

Then, immediately above the top nav row at line 86, insert the read-only banner:

```html
      <!-- Shared Observability: read-only banner (spec §3.2) -->
      <div x-show="viewAs" class="bg-amber-500/10 border-b border-amber-500/30 text-xs sm:text-sm text-amber-300 px-4 py-2"
           x-text="t('dash.viewingSharedBanner', { email: (sharedToMe.find(s => s.ownerId === viewAs) || {}).ownerEmail || '' })">
      </div>
```

- [ ] **Step 2: Hide the Keys nav button while viewing another user**

Locate the Keys nav `<button>` around line 97. Wrap it in a `<template x-if="!viewAs">` so it disappears entirely in shared mode:

```html
          <template x-if="!viewAs">
            <button @click="switchTab('keys')" class="px-3 py-1.5 sm:px-4 sm:py-2 rounded-md text-xs sm:text-sm font-medium transition-all whitespace-nowrap"
              :class="tab === 'keys' ? 'bg-surface-600 text-themed' : 'text-themed-dim hover:text-themed-secondary'"
              x-text="t('dash.apiKeys')">
            </button>
          </template>
```

- [ ] **Step 3: Add "My Sharing" item in user menu**

In the user menu dropdown around line 62 (between "Settings" and "Change Password" buttons), add a new `<button>`:

```html
              <button @click="loadSharedByMe(); mySharingOpen = true; userMenuOpen = false"
                      x-show="isUser"
                      class="w-full text-left px-4 py-2 text-sm text-themed-dim hover:text-themed hover:bg-surface-700 transition-colors cursor-pointer bg-transparent border-0">
                <span x-text="t('dash.mySharingMenu')"></span>
              </button>
```

- [ ] **Step 4: Add the "My Sharing" modal**

At the very end of the dashboard tabs HTML (just before the closing tag of the root container in tabs.ts), insert:

```html
  <!-- Shared Observability: My Sharing modal (spec §3.3) -->
  <div x-show="mySharingOpen" x-transition.opacity
       class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
       @click.self="mySharingOpen = false">
    <div class="bg-surface-800 border border-themed-border rounded-lg w-[480px] max-w-[95vw] p-5">
      <div class="flex items-start justify-between mb-3">
        <div>
          <h3 class="text-themed text-base font-semibold" x-text="t('dash.sharedObsTitle')"></h3>
          <p class="text-themed-dim text-xs mt-1" x-text="t('dash.sharedObsDesc')"></p>
        </div>
        <button @click="mySharingOpen = false" class="text-themed-dim hover:text-themed">&times;</button>
      </div>

      <div class="flex gap-2 mb-2">
        <input type="email" x-model="mySharingEmail" :placeholder="t('dash.sharedObsAddPlaceholder')"
               class="flex-1 text-sm" @keydown.enter="addMySharing()" />
        <button class="btn-primary !text-xs !py-1.5 !px-4" @click="addMySharing()" x-text="t('dash.sharedObsShare')"></button>
      </div>
      <div x-show="mySharingError" class="text-xs text-accent-red mb-2" x-text="mySharingError"></div>

      <div class="border-t border-themed-border pt-3 mt-2 max-h-[300px] overflow-y-auto">
        <div x-show="sharedByMe.length === 0" class="text-themed-dim text-xs text-center py-4"
             x-text="t('dash.sharedObsEmpty')"></div>
        <template x-for="g in sharedByMe" :key="g.viewerId">
          <div class="flex items-center justify-between py-2 border-b border-themed-border/40 last:border-0">
            <div class="min-w-0 flex-1">
              <div class="text-sm text-themed truncate" x-text="g.viewerName || g.viewerEmail"></div>
              <div class="text-[11px] text-themed-dim truncate" x-text="g.viewerEmail"></div>
              <div class="text-[10px] text-themed-dim" x-text="t('dash.sharedObsGrantedAt', { date: g.grantedAt })"></div>
            </div>
            <button class="btn-ghost !text-xs text-accent-red hover:bg-accent-red/10"
                    @click="revokeMySharing(g.viewerId)" x-text="t('dash.sharedObsRevoke')"></button>
          </div>
        </template>
      </div>
    </div>
  </div>
```

- [ ] **Step 5: Guard upstream account row click**

Search `src/ui/dashboard/tabs.ts` for the upstream-accounts table row (look for `@click` on the row that calls account-switch / GitHub switch logic). Wrap the click handler so it early-returns when `viewAs != null`:

```html
            @click="if (viewAs) return; selectAccount(acc.id)"
```

Also hide the row's "switch" button entirely in shared mode by adding `x-show="!viewAs"` to the button.

- [ ] **Step 6: Hide relay sensitive columns**

In the relays table, add `x-show="!viewAs"` to the `<th>` and corresponding `<td>` cells for hostname, IP, and URL columns. Locate them by grepping `tabs.ts` for column headers like `dash.relayHost`, `dash.relayIp`, `dash.relayUrl` (or actual literal labels if no key exists yet). The metric columns (request count, latency, error rate) remain visible.

- [ ] **Step 7: Manual visual smoke test**

Run: `bun run local`

- As User A: open user menu → "My Sharing" → add `b@example.com` → revoke → re-add
- As User B: dropdown appears in header → switch to A → banner shows → Keys nav gone → relays hide hostname column → upstream row click is no-op
- Switch back to Self: banner disappears, Keys nav reappears, own keys reload

- [ ] **Step 8: Commit**

```bash
git add src/ui/dashboard/tabs.ts
git commit -m "feat(ui): viewer dropdown, My Sharing modal, Keys/upstream/relay guards"
```

---

## Task 13: i18n keys (en + zh)

**Files:**
- Modify: `src/ui/i18n.ts`

- [ ] **Step 1: Add English keys**

In `src/ui/i18n.ts`, locate the `en:` block (begins line 8). Within the inner string-keyed object containing the `dash.*` entries, add the following entries (place them anywhere in the `dash.*` group; alphabetic order preferred):

```ts
      "dash.viewAsSelf": "Self",
      "dash.viewAsOwner": "Viewing: {name}",
      "dash.viewingSharedBanner": "Read-only view of {email}'s data",
      "dash.sharedObsTitle": "Shared Observability",
      "dash.sharedObsDesc": "Grant read-only access to your usage data",
      "dash.sharedObsAddPlaceholder": "viewer@example.com",
      "dash.sharedObsShare": "Share",
      "dash.sharedObsRevoke": "Revoke",
      "dash.sharedObsEmpty": "No one has access",
      "dash.sharedObsGrantedAt": "Granted {date}",
      "dash.sharedObsNotFound": "No user with that email",
      "dash.sharedObsCannotSelf": "Cannot share with yourself",
      "dash.sharedObsRevokedToast": "Access was revoked; switched back to your own data",
      "dash.mySharingMenu": "My Sharing",
```

- [ ] **Step 2: Add Chinese keys**

In the same file, locate the `zh:` block. Add the parallel translations:

```ts
      "dash.viewAsSelf": "本人",
      "dash.viewAsOwner": "查看：{name}",
      "dash.viewingSharedBanner": "正在以只读方式查看 {email} 的数据",
      "dash.sharedObsTitle": "共享可观测性",
      "dash.sharedObsDesc": "授予他人只读查看你使用数据的权限",
      "dash.sharedObsAddPlaceholder": "viewer@example.com",
      "dash.sharedObsShare": "分享",
      "dash.sharedObsRevoke": "撤销",
      "dash.sharedObsEmpty": "暂未分享给任何人",
      "dash.sharedObsGrantedAt": "{date} 授权",
      "dash.sharedObsNotFound": "未找到该邮箱对应的用户",
      "dash.sharedObsCannotSelf": "不能分享给自己",
      "dash.sharedObsRevokedToast": "授权已被撤销，已返回查看本人数据",
      "dash.mySharingMenu": "我的分享",
```

- [ ] **Step 3: Verify**

Run: `bun run local`

- Toggle UI language between EN/ZH
- Open "My Sharing" modal — every label is translated
- Switch viewAs context — banner uses correct language

- [ ] **Step 4: Commit**

```bash
git add src/ui/i18n.ts
git commit -m "i18n(dash): add shared-observability keys (en + zh)"
```

---

## Task 14: Final regression sweep + docs

**Files:**
- Run: full test suite
- Modify (only if needed): `README.md` (or relevant docs file) to mention the feature

- [ ] **Step 1: Run all tests**

Run: `bun test`

Expected: every test in the suite passes, including:
- `tests/observability-share-repo.test.ts` (Task 2)
- `tests/view-context.test.ts` (Task 6)
- `tests/redact-shared-view.test.ts` (Task 7)
- `tests/observability-share-integration.test.ts` (Task 8)
- `tests/upstream-accounts.test.ts` (Task 9 — added in Step 5 of that task)
- `tests/observability-share-routes.test.ts` (Task 10)
- All pre-existing tests (`tests/key-sharing.test.ts`, etc.) still pass

If any test fails: investigate the root cause; do not skip or comment out.

- [ ] **Step 2: Run typechecker**

Run: `bun run typecheck` (or `bunx tsc --noEmit` if no script defined)

Expected: zero errors. If errors appear in `client.ts` due to dynamic Alpine state typing, follow the existing convention used in the file (e.g., `// @ts-expect-error` or wider object typing — match what is already there).

- [ ] **Step 3: Manual end-to-end smoke test**

Run: `bun run local`

Walk through the full happy path:
1. User A signs in → opens "My Sharing" → adds B's email → list updates
2. User B signs in (different browser / private window) → header dropdown shows A → switches to A → banner appears → token usage / latency / relays panels show A's data → relay hostnames hidden → upstream row click is no-op → Keys nav hidden
3. User B sets `location.hash = '#keys'` manually → redirected to `#usage`
4. User A revokes B → User B's next observability fetch returns 403 → UI auto-falls-back to self with toast
5. User A sets dropdown back to "Self" → own keys reload → write actions usable again

Document any UI rough edges or polish items as follow-up issues; do NOT silently fix them in this task.

- [ ] **Step 4: Update README (if applicable)**

If the project README contains a feature list, add one bullet:

```md
- Shared observability — owners can grant read-only dashboard access to other users; viewers see usage/latency/relays/upstream-accounts only, with all secrets redacted and surrogate IDs in place of internal IDs.
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(share-observability): final regression sweep + docs"
```

---

## Self-Review Notes

After writing this plan, the author re-checked:

1. **Spec coverage:**
   - §1 Data model + repo → Tasks 1, 2, 3
   - §2.1 `resolveViewContext` middleware → Task 6
   - §2.2 Owned-only key scoping → Task 6 (transitive-leak regression test)
   - §2.3 Redaction + §2.3.1 HMAC surrogates → Task 7
   - §2.4.1 Token Usage / Latency → Task 8
   - §2.4.2 Upstream Accounts → Task 9
   - §2.4.3 Relays → Task 8 (relay handler refactor)
   - §2.5 Share-management routes → Task 10
   - §2.6 Closed allowlist → Tasks 5, 8, 10 (enforced by helper choice + authKind)
   - §3.1 Global view-as state → Task 11
   - §3.1.1 Boot sequence → Task 11 Step 3
   - §3.1.2 Context switch → Task 11 Step 2 (`switchViewAs`)
   - §3.2 Header dropdown → Task 12 Step 1
   - §3.3 "My Sharing" modal → Task 12 Steps 3-4
   - §3.4 i18n keys → Task 13
   - §3.5 Behavior constraints → Task 11 Steps 4-7 + Task 12 Steps 2, 5-6
   - §4.1 Backend tests → Tasks 2, 6, 7, 8, 9, 10
   - §4.2 Frontend tests → primarily manual smoke tests in Task 11 Step 9 and Task 12 Step 7 (Alpine state is hard to unit-test without a DOM harness; spec documents which assertions to verify)
   - §4.3 Boundaries & security → Task 5 (`authKind`) + Task 6 (middleware tests) + Task 7 (redaction tests) + Task 8 (cache key separation enforced by `effectiveUserId` substitution)
   - Cascade delete → Task 4

2. **Placeholder scan:** No `TBD`, `TODO`, `implement later`, `add validation`, "similar to Task N", or steps that describe without showing how. Every code step contains the actual code. Every command step contains the actual command.

3. **Type consistency:** `ObservabilityShare` shape (ownerId, viewerId, grantedAt, grantedBy) is identical across Tasks 1, 2, 3. Method signatures (`share`, `unshare`, `isGranted`, `listByOwner`, `listByViewer`, `deleteByOwner`, `deleteByViewer`) match between repo interface (Task 1) and SQLite/D1 implementations (Tasks 2-3) and route consumers (Tasks 4, 8, 10). `authKind` literal union (`'public'|'admin'|'session'|'apiKey'`) used in Tasks 5, 6, 8, 10 is consistent. Surrogate helper names (`sharedKeyRef`/`sharedAccountRef`/`sharedRelayRef`/`redactForSharedView`) match between Task 7 implementation and Tasks 8, 9 consumers. Frontend method names (`switchViewAs`, `observabilityFetch`, `loadSharedToMe`, `loadSharedByMe`, `addMySharing`, `revokeMySharing`, `fallBackToSelfFromShared`, `refreshAll`) match between Task 11 (definitions) and Task 12 (HTML callers).
