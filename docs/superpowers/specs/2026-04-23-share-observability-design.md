# Share Observability — Design Spec

**Date:** 2026-04-23
**Status:** Approved (revised after review round 4)

## Goal

Allow a user (the **owner**) to grant another user (the **viewer**) one-way, read-only access to their observability data — GitHub Copilot quota, token usage, latency, relay/upstream status — mirroring the existing share-key UX but for observation rather than execution.

## Scope

**In scope:**
- All observability panels currently visible on a user's own dashboard, exposed read-only to the viewer (Token Usage, Latency, Relays, Upstream/Quota, GitHub Accounts — list/quota only)
- Owner-side share management (add/remove a viewer by email)
- Viewer-side context switcher (dropdown to select whose data to view)
- One-way grant: owner → viewer
- `as_user` is honored **only** for dashboard session (cookie) auth — raw API key auth ignores it

**Out of scope:**
- Bidirectional/mutual sharing
- Granular per-panel permissions
- Sharing with non-existent accounts (invitations)
- Admin views (`/admin/...` endpoints unchanged)
- Exposing API key plaintext, key IDs, GitHub OAuth tokens, refresh tokens, or any actionable credential
- Transitive observability (keys assigned *to* the owner by third parties)
- Extending shared mode to any endpoint not in the closed allowlist (§2.6) without an explicit spec amendment

---

## § 1. Data Model

New table `observability_shares` (SQLite + D1 migrations):

| Column       | Type | Notes                                    |
|--------------|------|------------------------------------------|
| `owner_id`   | TEXT | Data owner (subject of observation)      |
| `viewer_id`  | TEXT | Granted observer                         |
| `granted_by` | TEXT | Initiator id (typically = `owner_id`)    |
| `granted_at` | TEXT | ISO timestamp                            |

- **Primary key:** `(owner_id, viewer_id)`
- **Index:** `(viewer_id)` — supports viewer-side lookup ("who shared with me")
- No FK constraints (consistent with `KeyAssignment`); deletions handled in app layer

### Repo interface

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

Registered on `Repo` as `observabilityShares`. SQLite + D1 implementations.

User deletion flow must call both `deleteByOwner` and `deleteByViewer`.

---

## § 2. Backend: Middleware + Routes

### 2.1 `resolveViewContext` middleware

`src/middleware/view-context.ts`

```ts
export const resolveViewContext = async ({ query, user, authKind, repo, set }) => {
  const asUser = query.as_user
  // Only dashboard session (cookie) auth may use as_user.
  // Raw API key auth ignores as_user (treated as if absent).
  if (!asUser || asUser === user.id || authKind !== 'session') {
    return { effectiveUserId: user.id, isViewingShared: false }
  }
  const granted = await repo.observabilityShares.isGranted(asUser, user.id)
  if (!granted) {
    set.status = 403
    throw new Error("Not authorized to view this user's observability data")
  }
  return { effectiveUserId: asUser, isViewingShared: true, ownerId: asUser }
}
```

Mounted on the observability route group. Each handler reads `effectiveUserId` (and may branch on `isViewingShared` for redaction) instead of `user.id` for data scoping.

Admin paths (`/admin/...`) do not use this middleware.

### 2.2 Owned-only key scoping (no transitive grants)

A new helper `getOwnedKeyIdsForScope(ownerId)` returns **only the keys created/owned by `ownerId`**, excluding any keys assigned to `ownerId` via `KeyAssignment`. This avoids transitive authorization leak (Bob viewing Alice should not see Carol's keys just because Carol shared a key with Alice).

- Self context (`isViewingShared = false`): existing scoping helper unchanged (still includes assigned keys)
- Shared context (`isViewingShared = true`): use `getOwnedKeyIdsForScope` for all data fetches (Token Usage, Latency, Relays, Upstream)

### 2.3 Response redaction in shared context

When `isViewingShared = true`, all observability handlers must strip:
- API key plaintext
- Internal key `id` (UUID/PK)
- GitHub OAuth `access_token`, `refresh_token`, OAuth scopes, internal account `id`
- Relay `clientName`, `clientIp`, `hostname`, `gatewayUrl`, request headers, any network metadata
- Any field that enables impersonation, execution, or infrastructure mapping

Allowed in shared responses:
- `keyName` (owner-supplied alias) — owner accepted disclosure by sharing
- Aggregated metrics (counts, tokens, latency)
- GitHub `login`, `avatar_url`, `active`, `token_valid`, quota figures
- Relay status, lastSeenAt, generic `clientLabel`

#### 2.3.1 Stable surrogate identifiers

To preserve dimensional grouping (key-level chart series, filters, distributions) without leaking internal IDs, the redactor maps real IDs to deterministic surrogates:

```
sharedKeyRef     = base64url(hmac_sha256(SERVER_SECRET, ownerId + ":key:"     + keyId)).slice(0, 16)
sharedAccountRef = base64url(hmac_sha256(SERVER_SECRET, ownerId + ":account:" + accountId)).slice(0, 16)
sharedRelayRef   = base64url(hmac_sha256(SERVER_SECRET, ownerId + ":relay:"   + clientId)).slice(0, 16)
```

Properties:
- Stable per owner (same input → same output across requests)
- Not correlatable across owners (owner-scoped namespace)
- Not reversible (HMAC with server-side secret)

`SERVER_SECRET` lives in env; rotation invalidates prior surrogates (acceptable — viewer just sees new IDs after rotation).

A helper `redactForSharedView(payload, ownerId)` is applied at the response edge of every affected handler. It performs both stripping and ID substitution.

### 2.4 Per-panel shared-mode payload shapes

#### 2.4.1 Token Usage / Latency

`keyId` field on every record replaced with `sharedKeyRef`. Filter options, chart series keys, and distributions all switch to `sharedKeyRef`. `keyName` remains as the human-readable label; if `keyName` is missing or duplicated across keys, the UI appends the last 6 chars of `sharedKeyRef` as a disambiguator.

#### 2.4.2 Upstream Accounts (`/api/upstream-accounts`)

Replaces the GitHub-accounts portion of `/auth/me` for both self and shared contexts. `/auth/me` no longer drives the upstream tab's account list.

Self-mode payload (returns full owner-visible shape — same fields the upstream panel uses today):
```ts
type UpstreamAccount = {
  id: string             // real account id
  login: string
  avatar_url: string
  active: boolean
  token_valid: boolean
  quota: { ... }
  // plus any other fields the existing panel relies on
}
```

Shared-mode payload (post-redaction):
```ts
type SharedAccount = {
  id: string             // sharedAccountRef — used as React key only, never sent back to any write endpoint
  login: string
  avatar_url: string
  active: boolean
  token_valid: boolean
  quota: { ... }
}
```

UI side:
- Both modes load accounts via `loadUpstreamAccounts()` from `/api/upstream-accounts` (via `observabilityFetch`). `loadMe()` keeps only identity fields and no longer holds the accounts array.
- When `viewAs != null`:
  - Row click handler (`switchActiveAccount`) early-returns; rows are styled with a read-only cursor and no hover affordance.
  - Re-auth / delete / any account write affordance is hidden.
  - Surrogate `id` is never passed to `/auth/github/switch` or any write endpoint (guarded both at the row-click handler and at the switch function entry).

#### 2.4.3 Relays

```ts
type SharedRelay = {
  id: string             // sharedRelayRef (HMAC of clientId)
  clientLabel: string    // derived from keyName, or "Relay #N" fallback
  status: 'connected' | 'disconnected' | ...
  lastSeenAt: string
}
```

UI side: when `viewAs != null`, the relays panel hides hostname / IP / URL columns. Only label + status + lastSeenAt are rendered.

### 2.5 Share-management routes

`src/routes/observability-shares.ts`

| Method | Path                                         | Purpose                                       |
|--------|----------------------------------------------|-----------------------------------------------|
| POST   | `/api/observability-shares`                  | Body `{ viewerEmail }` — grant access         |
| DELETE | `/api/observability-shares/:viewerId`        | Revoke access                                 |
| GET    | `/api/observability-shares/granted-by-me`    | List viewers I have granted (enriched)        |
| GET    | `/api/observability-shares/granted-to-me`    | List owners who have granted me (drives dropdown) |

Behavior:
- POST: look up viewer by email; 404 if not found; 400 if self-grant; **idempotent on duplicate** (returns 200 with the existing record)
- Returned records enrich with `id`, `email`, `displayName` for the counterparty
- These routes do **not** accept `as_user` (managing your own shares is a self-operation)

### 2.6 Closed allowlist of endpoints accepting `?as_user=<ownerId>`

The allowlist is **closed**. Adding new endpoints to shared mode requires an explicit spec amendment. Any user-scoped endpoint not in this list ignores `as_user` and operates on the caller.

Allowed endpoints:
- `/api/copilot-quota`
- `/api/token-usage` (non-admin path)
- `/api/latency`
- `/api/upstream-accounts` (new — replaces `/auth/me` for accounts list)
- Relay status endpoints (specific paths inventoried during plan)
- Upstream status endpoints (specific paths inventoried during plan)

Explicitly **not** in the allowlist:
- `/api/keys` (returns key plaintext — never shared)
- `/auth/me` (identity/session — always caller)
- All write endpoints
- All `/admin/...` endpoints

---

## § 3. Frontend: Viewer Dropdown + Share Management

### 3.1 Global view-as state

`src/ui/dashboard/client.ts` Alpine state additions (state field name `tab` matches existing convention at `client.ts:246`):

```js
viewAs: null,        // null = self; else ownerId
sharedToMe: [],      // [{ ownerId, ownerEmail, ownerName }]
sharedByMe: [],      // [{ viewerId, viewerEmail, viewerName, grantedAt }]
```

Two distinct fetch helpers — the choice itself is the security boundary:

```js
// Observability paths only. Adds ?as_user automatically.
observabilityFetch(path, opts = {}) {
  const url = new URL(path, location.origin)
  if (this.viewAs) url.searchParams.set('as_user', this.viewAs)
  return fetch(url, opts)
}

// Everything else (writes, /auth/me, /api/keys, settings, share-management itself):
// use the global fetch directly. NEVER appends as_user.
fetch(path, opts)
```

Frontend allowlist of paths that may use `observabilityFetch` (mirrors backend §2.6):
- `/api/token-usage`
- `/api/latency`
- `/api/copilot-quota`
- `/api/upstream-accounts`
- relay status endpoints
- upstream status endpoints

There is no central guard that "strips" `as_user` from disallowed paths; the boundary is enforced by helper choice. Disallowed paths must use plain `fetch`.

#### 3.1.1 Boot sequence (load order matters)

```js
async init() {
  // 1. Identity first (decides whether logged in)
  await this.loadMe()
  // 2. Pull granted-to-me list (decides dropdown visibility + validates stored viewAs)
  await this.loadSharedToMe()
  // 3. Validate and restore viewAs
  const stored = localStorage.getItem('viewAs') || null
  if (stored && this.sharedToMe.some(s => s.ownerId === stored)) {
    this.viewAs = stored
  } else {
    this.viewAs = null
    if (stored) localStorage.removeItem('viewAs')
  }
  // 4. Sanitize tab against shared mode (see §3.5 hash guard)
  if (this.viewAs && this.tab === 'keys') {
    this.tab = 'usage'
    location.hash = 'usage'
  }
  // 5. Now trigger first-round observability fetch
  this.refreshAll()
}
```

A 403 from any `observabilityFetch` call must also `localStorage.removeItem('viewAs')`, set `this.viewAs = null`, surface a notice, and re-run `refreshAll()` for self.

#### 3.1.2 Context switch

```js
switchViewAs(ownerId) {
  this.viewAs = ownerId
  if (ownerId) {
    localStorage.setItem('viewAs', ownerId)
    // Entering shared mode: drop key state, leave keys tab if active
    this.keys = []
    if (this.tab === 'keys') {
      this.tab = 'usage'
      location.hash = 'usage'
    }
  } else {
    localStorage.removeItem('viewAs')
    // Returning to self: reload keys exactly once
    this.loadKeys()
  }
  this.refreshAll()
}
```

### 3.2 Header dropdown

Top of dashboard, beside user menu. Visible only when `sharedToMe.length > 0`.

```html
<select x-show="sharedToMe.length > 0"
        @change="switchViewAs($event.target.value || null)">
  <option :value="''" x-text="t('dash.viewAsSelf')"></option>
  <template x-for="s in sharedToMe">
    <option :value="s.ownerId"
            x-text="t('dash.viewAsOwner', { name: s.ownerName || s.ownerEmail })"></option>
  </template>
</select>
```

When viewing another user's data, show a banner:
> Read-only view of `<ownerEmail>`'s data

### 3.3 "My Sharing" entry for regular users

Regular users do not have a Settings tab (Settings exists for admin only — see `src/ui/dashboard/tabs.ts:1344`). To avoid creating a new top-level tab and to match the existing share-key visual pattern, the share-management UI is reached via the **user menu dropdown** (top-right) → "My Sharing" item, which opens a modal.

The modal contains:
- Email input + "Share" button → POST `/api/observability-shares`
- List of current grantees (email, granted_at, revoke button) → DELETE `/api/observability-shares/:viewerId`

Visual style mirrors the existing share-key panel (`src/routes/api-keys.ts:332` flow).

### 3.4 i18n keys (en + zh)

```
dash.viewAsSelf              "Self" / "本人"
dash.viewAsOwner             "Viewing: {name}" / "查看：{name}"
dash.viewingSharedBanner     "Read-only view of {email}'s data" / "正在以只读方式查看 {email} 的数据"
dash.sharedObsTitle          "Shared Observability" / "共享可观测性"
dash.sharedObsDesc           "Grant read-only access to your usage data" / "授予他人只读查看你使用数据的权限"
dash.sharedObsAddPlaceholder "viewer@example.com"
dash.sharedObsShare          "Share" / "分享"
dash.sharedObsRevoke         "Revoke" / "撤销"
dash.sharedObsEmpty          "No one has access" / "暂未分享给任何人"
dash.sharedObsGrantedAt      "Granted {date}" / "{date} 授权"
dash.mySharingMenu           "My Sharing" / "我的分享"
```

### 3.5 Behavior constraints

- When viewing another user's context, all write actions (rotate key, change password, share-key management, account switch, etc.) are disabled or hidden
- `viewAs` persists across reloads via `localStorage` and is restored only after `sharedToMe` validation (§3.1.1)
- If a 403 is returned (grant revoked), auto-fall-back to self, clear localStorage, and show a notice
- The viewer never sees `/api/keys` data for the owner — the keys panel is hidden in shared context
- **Keys tab navigation hardening:** when `viewAs != null`:
  - The top-level Keys nav item is hidden (state-bound)
  - `switchTab('keys')` is intercepted (no-op) — defends against programmatic calls
  - The hash watcher (currently `client.ts:534` `if (this.tab !== h) this.switchTab(h)`) must reject `h === 'keys'` while `viewAs != null` and instead force `tab = 'usage'` and rewrite `location.hash = 'usage'` — defends against manual URL editing
  - Loaded `this.keys` state is cleared on enter to prevent stale-data flash
  - On switch back to self, the Keys nav reappears and `loadKeys()` is invoked exactly once
- Upstream account row click handler early-returns when `viewAs != null`; surrogate id is never sent to `/auth/github/switch`

---

## § 4. Testing & Boundaries

### 4.1 Backend tests

- `ObservabilityShareRepo` unit tests (SQLite + D1): share/unshare/list/isGranted/cascade delete
- `resolveViewContext` middleware:
  - No `as_user` → uses caller id
  - `as_user` = self → uses caller id
  - Not granted (session auth) → 403
  - Granted (session auth) → `effectiveUserId` = ownerId, `isViewingShared = true`
  - **API key auth + `as_user`** → ignored, `effectiveUserId` = caller id
- `getOwnedKeyIdsForScope`: assigned keys are excluded; only owned keys returned
- `redactForSharedView`: API key plaintext, key id, OAuth tokens, relay hostnames/IPs/URLs removed; keyName, login, avatar, active, token_valid, metrics retained
- Surrogate stability: `sharedKeyRef` / `sharedAccountRef` / `sharedRelayRef` deterministic per (ownerId, realId); identical input → identical output across calls; different owners with same realId → different surrogates; non-reversible without `SERVER_SECRET`
- Integration: viewer with `?as_user=` (session auth) calls `/api/token-usage`, `/api/copilot-quota`, `/api/latency`, `/api/upstream-accounts` → returns owner's data, redacted, owned-only, with surrogate IDs in place of internal IDs
- Transitive-leak regression test: Carol shares key with Alice; Bob has Alice's grant; Bob's view excludes Carol's key
- Closed-allowlist regression: `/api/keys?as_user=...` ignores `as_user` (returns caller's keys); `/auth/me?as_user=...` likewise ignored
- Error paths: self-grant (400), viewer email not found (404); duplicate grant returns 200 with existing record

### 4.2 Frontend tests

- `observabilityFetch` appends `as_user` only when `viewAs` is set; plain `fetch` (used for write paths, `/auth/me`, `/api/keys`, share-management endpoints) never appends it — verified by interception test on each call site
- Boot sequence: stored `viewAs` not in `sharedToMe` is cleared from localStorage and not applied; first observability fetch only fires after sharedToMe is loaded
- Dropdown switch triggers `refreshAll`
- `viewAs` localStorage persistence + restore across reload
- 403 auto-fallback to self clears localStorage and re-fetches
- Keys tab hidden when `viewAs != null`; if `tab === 'keys'` at switch time, it becomes `'usage'` and hash updated; `keys` state cleared
- Hash guard: setting `location.hash = '#keys'` while `viewAs != null` redirects to `'usage'`
- `switchTab('keys')` while `viewAs != null` is a no-op
- Switching back to self re-shows the Keys nav and triggers `loadKeys()` exactly once
- Upstream accounts panel loads via `/api/upstream-accounts` in both modes; row click in shared mode does nothing; surrogate id never reaches `/auth/github/switch`
- Relays panel hides hostname / IP / URL columns when `viewAs != null`
- Token Usage / Latency dimensions group by `sharedKeyRef` (not `keyId`) when `viewAs != null`; duplicate/missing keyName disambiguator (last 6 chars of `sharedKeyRef`) renders correctly

### 4.3 Boundaries & security

- Admin endpoints (`/admin/...`) ignore `as_user` (no error)
- Cache keys must include `effectiveUserId` (not caller id) to prevent cross-user contamination
- Write endpoints ignore `as_user` even if supplied
- API key authenticated requests ignore `as_user` (only dashboard session auth honors it)
- Concurrency: after revoke, in-flight requests may serve one stale response; subsequent requests 403
- No endpoint in shared context returns API key plaintext, key id, or OAuth tokens — enforced by `redactForSharedView`
- Allowlist is closed; new shared endpoints require explicit spec amendment

---

## Open questions

None at design-approval time.
