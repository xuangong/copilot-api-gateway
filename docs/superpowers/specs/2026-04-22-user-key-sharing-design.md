# User-Facing Key Sharing — Design

**Date:** 2026-04-22
**Status:** Draft, awaiting user review

## Problem

Today only admins can share an API key with another user. The flow uses a Users tab that lists every user in the system, then opens a modal to pick keys to assign. Regular users have no way to share their own keys, and exposing the full user list to them is undesirable.

We want regular users to share their own keys with another user by typing that user's email, see who they have shared with, and revoke a share. Admin's existing experience stays unchanged.

## Goals

- Key owner can share by email, see assignees, and unshare.
- Owner cannot enumerate other users.
- Admin's existing Users-tab flow is untouched.
- Regular user's API Keys page shows the same row layout admin sees.
- Minimal new surface area: extend existing endpoints rather than add parallel ones.

## Non-Goals

- No bulk share, no share-link, no expirations.
- No rate-limiting of email lookup in this iteration (small user base; revisit if abused).
- No notification to the recipient.

## Architecture

Pure incremental change. No new tables, no new endpoints. Existing admin-only assign endpoints get their guard widened to "admin OR key owner", and the assign endpoint additionally accepts an `email` field. The frontend reuses the admin "Shared With" panel and adds an email-based share input that shows for the key owner.

## Backend Changes

File: `src/routes/api-keys.ts`

### `POST /api/keys/:id/assign`

- **Guard:** `isAdmin || (key.ownerId === ctx.userId)`. Otherwise `403 { error: "Forbidden" }`.
- **Body:** `{ user_id?: string, email?: string }` — exactly one required.
  - If `user_id` is present, behave as today (admin path).
  - If `email` is present, resolve via `repo.users.findByEmail(email.trim().toLowerCase())`.
  - If both present, prefer `user_id` and ignore `email`.
  - If neither present → `400 { error: "user_id or email is required" }`.
- **Validations (in order):**
  1. Key exists → else `404 { error: "Key not found" }`.
  2. Target user resolves → else `404 { error: "No user with that email" }` (when email path) / `404 { error: "User not found" }` (when user_id path).
  3. Target user ≠ key owner → else `400 { error: "Cannot share key with yourself" }`.
  4. Not already shared with that user → else `409 { error: "Already shared with this user" }`. Detect via `repo.keyAssignments.listByKey(id)` membership check.
- **Success:** `repo.keyAssignments.assign(keyId, userId, ctx.userId ?? "admin")` → `{ ok: true }`.

### `DELETE /api/keys/:id/assign/:userId`

- **Guard:** `isAdmin || (key.ownerId === ctx.userId)`. Otherwise `403`.
- **Behavior:** unchanged — `repo.keyAssignments.unassign(keyId, userId)` → `{ ok: true }`. Idempotent on missing assignment.

### `GET /api/keys/:id/assignments`

- No change. Already supports admin OR key owner.

### Helper

Extract a small `assertOwnerOrAdmin(keyId, ctx): Promise<{ key } | Response>` to avoid duplicating the guard across the two routes. Returns either the loaded key or the 403/404 Response.

## Frontend Changes

Files: `src/ui/dashboard/client.ts`, `src/ui/dashboard/tabs.ts` (keys table panel only).

### Row visibility

`/api/keys` already returns each row with an `is_owner` flag. Today the keys table renders all rows for the current user (own keys + keys shared to them). Regular user view changes:

- Keep rendering both kinds of rows.
- For `is_owner: true` rows: render the same "Shared With" panel that admin sees today, **plus** the new email-share input and per-row Unshare buttons.
- For `is_owner: false` rows: render a read-only "Shared with you by {ownerName}" line. No share panel.

Admin keeps both the existing Users-tab modal flow and gets the same in-row share affordances on rows they own.

### "Shared With" panel additions

Inside the existing expandable panel (`client.ts` ~line 571–584):

- For each existing assignee line, append a small `✕` "Unshare" button. On click → `DELETE /api/keys/:id/assign/:userId`. On 200 → toast "Unshared" and re-fetch assignments.
- Below the assignee list, add a single-line form:
  - Input: `<input type="email" placeholder="user@example.com">`
  - Button: `Share`
  - On submit:
    - Validate non-empty + basic email shape client-side; otherwise inline "Enter a valid email".
    - `POST /api/keys/:id/assign` with `{ email }`.
    - 200 → clear input, toast "Shared with {email}", re-fetch assignments.
    - 404 → inline "No user with that email".
    - 400 (self) → inline "You can't share a key with yourself".
    - 409 (already) → inline "Already shared with {email}".
    - 403 → inline "Not allowed".
    - other → inline "Failed to share".

Inline error appears next to the input and clears on next keystroke.

### Admin Users-tab flow

Untouched. Admin still sees the Users tab and the per-user assign modal. No regression.

## Data Flow

```
Owner types email → POST /assign { email }
  → backend resolves email → userId
  → validates not-self, not-duplicate
  → keyAssignments.assign()
  → returns { ok: true }
Owner views row → GET /assignments → render assignee list with ✕ buttons
Owner clicks ✕ → DELETE /assign/:userId → re-fetch
```

## Error Handling Summary

| Scenario | HTTP | Body | UI |
|---|---|---|---|
| Caller not owner/admin | 403 | `{ error: "Forbidden" }` | "Not allowed" |
| Key missing | 404 | `{ error: "Key not found" }` | "Key not found" |
| Email has no user | 404 | `{ error: "No user with that email" }` | "No user with that email" |
| Share with self | 400 | `{ error: "Cannot share key with yourself" }` | "You can't share a key with yourself" |
| Duplicate share | 409 | `{ error: "Already shared with this user" }` | "Already shared with {email}" |
| Missing identifier | 400 | `{ error: "user_id or email is required" }` | (admin path only) |

## Testing

Backend (`bun test`):

- `POST /assign` as owner with valid email → 200, assignment created.
- `POST /assign` as owner with non-existent email → 404.
- `POST /assign` as owner with own email → 400 self-share.
- `POST /assign` as owner with already-shared user email → 409.
- `POST /assign` as stranger (not owner, not admin) → 403.
- `POST /assign` as admin with `user_id` → 200 (regression).
- `POST /assign` with neither field → 400.
- `DELETE /assign/:userId` as owner → 200, assignment removed.
- `DELETE /assign/:userId` as stranger → 403.
- `DELETE /assign/:userId` for non-existent assignment as owner → 200 (idempotent).

Frontend: smoke-test the email input + Unshare button paths via the existing dashboard test setup, if present; otherwise rely on backend coverage and manual verification.

## Out of Scope / Future

- Rate-limiting `/assign` to mitigate email enumeration if user base grows.
- Sending an in-app or email notification to the recipient.
- Permission scoping per-share (read-only vs full).
