# Admin GitHub Account Quota — Design

**Date:** 2026-04-23
**Status:** Draft, awaiting user review

## Problem

Admins can already see which users have linked GitHub accounts (Settings → Users, where each user row lists `@login` chips for every bound GitHub account). What they cannot see is how much Copilot quota each of those GitHub accounts has left. They have to ask the user, or sign in as that user, to find out.

## Goals

- Admin can view current Copilot quota for every GitHub account already shown in the Users list.
- All quotas load automatically alongside the Users list (no manual click per account).
- Failure on one account does not block the others.
- Reuse the existing `copilot_internal/user` integration — no new GitHub API contract to maintain.

## Non-Goals

- No server-side caching, polling, or push updates.
- No batch endpoint (frontend fans out per account).
- No historical quota chart / trend.
- No exposure to non-admin users (regular users still only see their own active account via `/api/copilot-quota`).
- No auto-refresh after initial load (re-entering the Settings tab refetches naturally).

## Architecture

One new admin-only endpoint: `GET /api/admin/copilot-quota/:githubUserId`. It is a thin wrapper that locates the stored access token for the given GitHub account, then makes the same `https://api.github.com/copilot_internal/user` call the existing `/api/copilot-quota` route makes — but scoped to a target account instead of the caller's active account.

The frontend, after loading `/auth/admin/users`, fans out one request per `gh.id` it encounters and stores results in a reactive map keyed by GitHub user id. UI renders a per-account chip next to each `@login`.

No schema change. No new repo method beyond what `repo.github` already exposes.

## Backend Changes

### `GET /api/admin/copilot-quota/:githubUserId`

File: `src/routes/dashboard.ts` (next to existing `/copilot-quota`).

**Guard:** `isAdmin === true`. Otherwise:
```json
{ "error": "Admin only" }
```
Status `403`.

**Lookup:**
1. `repo.github.findAccount(githubUserId)` (or equivalent — see "Repo additions" below). If not found → `404 { "error": "GitHub account not found" }`.
2. Pull access token from the stored account record (same field the existing flow uses).

**Upstream call:**
```ts
const resp = await fetch("https://api.github.com/copilot_internal/user", {
  headers: createGithubHeaders(token),
})
```

**Response handling:**
- `resp.ok`: return the parsed JSON body verbatim. Same shape the existing `/api/copilot-quota` returns (frontend already knows how to read it).
- `!resp.ok`: pass through upstream `status` plus `{ error: "GitHub API error: <status> <text>" }`.
- Thrown error (network, token decrypt failure, etc.): `502 { error: <message> }`.

### Repo additions

None. Use the existing `repo.github.listAccounts()` and find the target account inline:
`accounts.find(a => String(a.user.id) === String(githubUserId))`. Account counts in this admin scope are small; no need for a new indexed lookup method yet.

## Frontend Changes

### State (`src/ui/dashboard/client.ts`)

Add to the Alpine component, near other admin state:

```js
githubQuotas: {},          // { [githubUserId]: { loading, error, data } }
githubQuotaLoading: false, // overall load flag (optional, used only if a global spinner is desired)
```

### Trigger

Inside the existing `loadAdminUsers()` (or whichever method populates `adminUsers`), after the user list is available:

```js
const ids = []
for (const u of this.adminUsers) {
  for (const gh of (u.githubAccounts || [])) {
    if (gh.id != null) ids.push(gh.id)
  }
}
// Mark all as loading (synchronous, so UI shows spinner immediately)
for (const id of ids) {
  this.githubQuotas[id] = { loading: true, error: '', data: null }
}
// Fan out — do NOT await sequentially
ids.forEach(id => { this.loadGithubQuota(id) })
```

`loadGithubQuota(id)`:

```js
async loadGithubQuota(id) {
  try {
    const resp = await fetch('/api/admin/copilot-quota/' + encodeURIComponent(id), {
      credentials: 'same-origin',
    })
    if (resp.ok) {
      const data = await resp.json()
      this.githubQuotas[id] = { loading: false, error: '', data }
    } else {
      let errText = ''
      try { const j = await resp.json(); errText = j?.error || ''; } catch (_) {}
      this.githubQuotas[id] = { loading: false, error: errText || ('HTTP ' + resp.status), data: null }
    }
  } catch (e) {
    this.githubQuotas[id] = { loading: false, error: this.t('dash.quotaLoadFailed'), data: null }
  }
},
```

### Helper for display

The `copilot_internal/user` payload contains a `quota_snapshots` object keyed by quota type (e.g. `premium_interactions`, `chat`, `completions`). Each snapshot has `entitlement`, `remaining`, `percent_remaining`, `unlimited`. Add a small computed helper:

```js
formatQuotaChip(q) {
  if (!q) return ''
  if (q.loading) return '…'
  if (q.error) return '!'
  const snap = q.data?.quota_snapshots?.premium_interactions
  if (!snap) return '—'
  if (snap.unlimited) return '∞'
  const used = snap.entitlement - snap.remaining
  return used + '/' + snap.entitlement
},
```

(The "premium_interactions" choice is the most user-relevant ceiling. If the response shape differs, fall back to whichever first snapshot has `entitlement`.)

### Render (`src/ui/dashboard/tabs.ts:193-195`)

Replace the current single-line login chip:

```html
<template x-for="gh in (u.githubAccounts || [])" :key="gh.id">
  <span class="text-xs text-themed-dim" x-text="'@' + gh.login"></span>
</template>
```

with:

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

### i18n (`src/ui/i18n.ts`)

Add to both `en` and `zh` blocks:

| key | en | zh |
|---|---|---|
| `dash.copilotQuota` | Copilot quota | Copilot 配额 |
| `dash.quotaLoadFailed` | Failed to load quota | 加载配额失败 |

## Error Handling Summary

| Scenario | Backend HTTP | Backend Body | UI |
|---|---|---|---|
| Not admin | 403 | `{"error":"Admin only"}` | Chip shows `!` with tooltip |
| Unknown GitHub user id | 404 | `{"error":"GitHub account not found"}` | Chip shows `!` with tooltip |
| Upstream non-2xx (e.g. 401 token expired) | upstream status | `{"error":"GitHub API error: <status> <text>"}` | Chip shows `!` with tooltip |
| Network / token decrypt error | 502 | `{"error":"<message>"}` | Chip shows `!` with tooltip |
| Success | 200 | upstream JSON | Chip shows `used/entitlement` (or `∞`) |

## Testing

Backend (`bun test`, new file `tests/admin-copilot-quota.test.ts`). Mock `globalThis.fetch` so no real GitHub call is made:

1. Admin + valid GitHub user id → 200, body matches mocked upstream JSON.
2. Non-admin (regular user) → 403.
3. Admin + unknown GitHub user id → 404.
4. Admin + upstream returns 401 → response is 401 with `error` containing `"GitHub API error: 401"`.
5. Admin + `fetch` throws → 502.

Frontend: rely on backend coverage for the matrix; no Alpine snapshot test needed for what is essentially a chip render. Manual smoke check after merge.

## Out of Scope / Future

- Server-side cache to avoid hammering GitHub when many admins or many accounts.
- A batched endpoint that returns all quotas in one call.
- Historical quota tracking / charts.
- Surfacing quota for non-admin views (e.g. owner sees own GitHub account quota inline).
- Distinguishing multiple snapshot types (chat vs completions vs premium) in the chip.
