# Change Password — Design

**Date:** 2026-04-22
**Status:** Draft, awaiting user review

## Problem

Email-registered users currently have no in-app way to change their password. The account dropdown in the dashboard top-right only exposes Settings (admin) and Sign Out. OAuth-registered users (Google/GitHub) have no password at all.

## Goals

- Email-auth users can change their password from the account dropdown.
- OAuth users see no Change Password entry at all.
- Old password required (prevents session-hijack abuse).
- Reuse existing password rules and PBKDF2 hashing.
- Minimal new surface area: one new endpoint, one new modal.

## Non-Goals

- No "log out other sessions" sweep.
- No email/in-app notification of password change.
- No password complexity rules beyond the existing 6-char minimum (matches register endpoint).
- No password reset / forgot-password flow (already covered by magic link elsewhere).

## Architecture

One new POST endpoint. One new boolean field on the session response (`hasPassword`) so the frontend can hide/show the menu item. One Alpine modal in the dashboard. No schema changes — `users.passwordHash` already exists and `repo.users.update` already supports it.

## Backend Changes

### `POST /auth/email/change-password`

File: `src/routes/auth.ts`

- **Guard:** session must resolve to a real user (not the admin shared key, not an API key). Otherwise `401 { error: "Unauthorized" }`.
- **Body:** `{ old_password: string, new_password: string }`.
- **Validations (in order):**
  1. Both fields present and non-empty → else `400 { error: "old_password and new_password are required" }`.
  2. `new_password.length >= 6` → else `400 { error: "Password must be at least 6 characters" }`.
  3. User has a `passwordHash` → else `400 { error: "This account uses OAuth sign-in" }`.
  4. `verifyPassword(old_password, user.passwordHash)` → else `401 { error: "Incorrect password" }`.
  5. `new_password !== old_password` → else `400 { error: "New password must be different" }`.
- **Success:** `repo.users.update(userId, { passwordHash: await hashPassword(new_password) })` → `{ ok: true }`.
- Session is **not** invalidated. Other sessions are **not** logged out.

Resolution of `userId` mirrors `POST /auth/login`: read `session_token` from `Cookie` header (or request body fallback for parity), look it up in `repo.sessions`, return 401 if missing/expired/admin-key.

### `POST /auth/login` response addition

Add `hasPassword: !!user.passwordHash` to the success payload (`auth.ts:240`). Pure additive change; existing clients ignore unknown fields.

## Frontend Changes

### Account dropdown (`src/ui/dashboard/tabs.ts:46–72`)

Insert between Settings and Sign Out, gated by `x-show="hasPassword"`:

```html
<button
  type="button"
  x-show="hasPassword"
  @click="openChangePasswordModal()"
  class="..."
  x-text="t('dash.changePassword')"
></button>
```

### `src/ui/dashboard/client.ts`

Reactive state (near other auth state):

```js
hasPassword: false,
changePasswordOpen: false,
cpOldPassword: '',
cpNewPassword: '',
cpConfirmPassword: '',
cpError: '',
cpSubmitting: false,
```

`hasPassword` is set from the `/auth/login` response (alongside `isAdmin`, `isUser`, etc).

Methods:

```js
openChangePasswordModal() {
  this.cpOldPassword = '';
  this.cpNewPassword = '';
  this.cpConfirmPassword = '';
  this.cpError = '';
  this.changePasswordOpen = true;
},

closeChangePasswordModal() {
  this.changePasswordOpen = false;
},

async submitChangePassword() {
  this.cpError = '';
  if (!this.cpOldPassword || !this.cpNewPassword || !this.cpConfirmPassword) {
    this.cpError = this.t('dash.changePasswordErrEmpty');
    return;
  }
  if (this.cpNewPassword.length < 6) {
    this.cpError = this.t('dash.passwordMinLength');
    return;
  }
  if (this.cpNewPassword !== this.cpConfirmPassword) {
    this.cpError = this.t('dash.passwordMismatch');
    return;
  }
  this.cpSubmitting = true;
  try {
    const resp = await fetch('/auth/email/change-password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        old_password: this.cpOldPassword,
        new_password: this.cpNewPassword,
      }),
    });
    if (resp.ok) {
      this.changePasswordOpen = false;
      this.toast && this.toast(this.t('dash.passwordChangedToast'));
      return;
    }
    let serverError = '';
    try { const data = await resp.json(); serverError = data?.error || ''; } catch (_e) {}
    if (resp.status === 401 && serverError.toLowerCase().includes('incorrect')) {
      this.cpError = this.t('dash.passwordIncorrect');
    } else if (resp.status === 400 && serverError.toLowerCase().includes('oauth')) {
      this.cpError = this.t('dash.changePasswordErrOAuth');
    } else if (resp.status === 400 && serverError.toLowerCase().includes('different')) {
      this.cpError = this.t('dash.passwordSameAsOld');
    } else if (resp.status === 400 && serverError.toLowerCase().includes('6 characters')) {
      this.cpError = this.t('dash.passwordMinLength');
    } else {
      this.cpError = this.t('dash.changePasswordErrGeneric');
    }
  } catch (_e) {
    this.cpError = this.t('dash.changePasswordErrGeneric');
  } finally {
    this.cpSubmitting = false;
  }
},
```

### Modal template (`src/ui/dashboard/tabs.ts`)

Append a new section near other top-level overlays. Backdrop click + Escape close the modal. Three password inputs, error `<p>`, Cancel + Submit buttons. Submit disabled while `cpSubmitting`.

### i18n (`src/ui/i18n.ts`)

Add the following keys to both `en` and `zh` blocks:

| key | en | zh |
|---|---|---|
| `dash.changePassword` | Change Password | 修改密码 |
| `dash.changePasswordTitle` | Change your password | 修改密码 |
| `dash.oldPassword` | Current password | 当前密码 |
| `dash.newPassword` | New password | 新密码 |
| `dash.confirmNewPassword` | Confirm new password | 确认新密码 |
| `dash.changePasswordSubmit` | Update password | 更新密码 |
| `dash.passwordMinLength` | Password must be at least 6 characters | 密码长度至少 6 位 |
| `dash.passwordMismatch` | New passwords do not match | 两次输入的新密码不一致 |
| `dash.passwordIncorrect` | Current password is incorrect | 当前密码不正确 |
| `dash.passwordSameAsOld` | New password must differ from the current one | 新密码不能与当前密码相同 |
| `dash.changePasswordErrEmpty` | All fields are required | 请填写所有字段 |
| `dash.changePasswordErrOAuth` | This account uses OAuth sign-in | 该账号通过 OAuth 登录，无密码可改 |
| `dash.changePasswordErrGeneric` | Failed to change password | 修改密码失败 |
| `dash.passwordChangedToast` | Password changed | 密码已更新 |

## Error Handling Summary

| Scenario | HTTP | Body | UI |
|---|---|---|---|
| No session / admin key | 401 | `{ error: "Unauthorized" }` | (modal closed; user re-login) |
| Missing field | 400 | `{ error: "old_password and new_password are required" }` | "All fields are required" |
| New password too short | 400 | `{ error: "Password must be at least 6 characters" }` | "Password must be at least 6 characters" |
| OAuth user (no hash) | 400 | `{ error: "This account uses OAuth sign-in" }` | "This account uses OAuth sign-in" |
| Wrong old password | 401 | `{ error: "Incorrect password" }` | "Current password is incorrect" |
| New equals old | 400 | `{ error: "New password must be different" }` | "New password must differ from the current one" |
| Other | 500 | `{ error: "Failed" }` | "Failed to change password" |

## Testing

Backend (`bun test`, new file `tests/auth-change-password.test.ts`):

1. Logged in + correct old + valid new → 200; new password works for `/auth/email/login`; old password rejected.
2. Wrong old password → 401 "Incorrect password".
3. New password < 6 chars → 400.
4. OAuth user (no `passwordHash`) → 400 "OAuth sign-in".
5. New password equals old → 400 "different".
6. Missing field → 400.
7. No session cookie → 401 "Unauthorized".

Frontend: smoke test modal open/close + submit happy path; rely on backend coverage for error matrix.

## Out of Scope / Future

- "Log out all other sessions" toggle.
- Email notification on password change.
- Password complexity rules (uppercase, digits, symbols).
- Re-issue session token after change.
