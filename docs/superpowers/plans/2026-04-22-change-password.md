# Change Password Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Allow email-auth users to change their password from the dashboard account dropdown. OAuth users see no menu entry.

**Architecture:** New `POST /auth/email/change-password` endpoint reusing existing PBKDF2 password lib + `repo.users.update`. Login response gains `hasPassword` boolean. Dashboard adds a gated menu item + Alpine modal.

**Tech Stack:** Bun, Elysia, SQLite (in-memory for tests), Alpine.js, Tailwind, PBKDF2-SHA256.

---

## Task 1: Backend tests (TDD red)

**Files:**
- Create: `tests/auth-change-password.test.ts`

Write 7 integration tests against a minimal Elysia app that mounts `authRoute` with an in-memory repo. Use the same harness style as `tests/key-sharing.test.ts` (`setRepoForTest`, `:memory:` SQLite).

Tests:
1. **happy path:** create email user with hash of "oldpw123", create session, POST `/auth/email/change-password` with cookie + correct old/new → 200; then `/auth/email/login` with new password works (200), with old password fails (401).
2. wrong old password → 401, body `{ error: "Incorrect password" }`.
3. new password length 5 → 400, body contains `"6 characters"`.
4. user has no `passwordHash` (OAuth) → 400, body contains `"OAuth"`.
5. new == old → 400, body contains `"different"`.
6. missing body field → 400, body `{ error: "old_password and new_password are required" }`.
7. no session cookie → 401, body `{ error: "Unauthorized" }`.

Run `bun test tests/auth-change-password.test.ts` — expect all 7 to fail with 404 (route doesn't exist yet).

Commit: `test(auth): change-password endpoint coverage`

---

## Task 2: Backend POST /auth/email/change-password

**Files:**
- Modify: `src/routes/auth.ts`

Add route after the existing `/auth/email/login` handler (~line 980). Imports already present (`hashPassword`, `verifyPassword`, `getRepo`).

Handler skeleton:

```ts
.post("/email/change-password", async (ctx) => {
  // 1. resolve session: read session_token from cookie or body
  const cookieHeader = ctx.request.headers.get("cookie") || ""
  const match = cookieHeader.match(/(?:^|;\s*)session_token=([^\s;]+)/)
  const sessionToken = match?.[1]
  if (!sessionToken || !sessionToken.startsWith("ses_")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } })
  }
  const repo = getRepo()
  const session = await repo.sessions.findByToken(sessionToken)
  if (!session || new Date(session.expiresAt) <= new Date()) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } })
  }
  const user = await repo.users.getById(session.userId)
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } })
  }

  // 2. validate body
  const { old_password, new_password } = (ctx.body ?? {}) as { old_password?: string; new_password?: string }
  if (!old_password || !new_password) {
    return new Response(JSON.stringify({ error: "old_password and new_password are required" }), { status: 400, headers: { "Content-Type": "application/json" } })
  }
  if (new_password.length < 6) {
    return new Response(JSON.stringify({ error: "Password must be at least 6 characters" }), { status: 400, headers: { "Content-Type": "application/json" } })
  }
  if (!user.passwordHash) {
    return new Response(JSON.stringify({ error: "This account uses OAuth sign-in" }), { status: 400, headers: { "Content-Type": "application/json" } })
  }

  // 3. verify old password
  const valid = await verifyPassword(old_password, user.passwordHash)
  if (!valid) {
    return new Response(JSON.stringify({ error: "Incorrect password" }), { status: 401, headers: { "Content-Type": "application/json" } })
  }

  // 4. reject same password
  if (old_password === new_password) {
    return new Response(JSON.stringify({ error: "New password must be different" }), { status: 400, headers: { "Content-Type": "application/json" } })
  }

  // 5. update
  const newHash = await hashPassword(new_password)
  await repo.users.update(user.id, { passwordHash: newHash })
  return { ok: true }
})
```

Run `bun test tests/auth-change-password.test.ts` — all 7 should pass.

Commit: `feat(auth): change-password endpoint`

---

## Task 3: Add hasPassword to /auth/login response

**Files:**
- Modify: `src/routes/auth.ts:240` (the `data` object inside the `ses_` branch of `/auth/login`)

Change:

```ts
const data = { ok: true, isAdmin, isUser: true, userId: user.id, userName: user.name, email: user.email, avatarUrl: user.avatarUrl, sessionToken, disabled: user.disabled }
```

to:

```ts
const data = { ok: true, isAdmin, isUser: true, userId: user.id, userName: user.name, email: user.email, avatarUrl: user.avatarUrl, sessionToken, disabled: user.disabled, hasPassword: !!user.passwordHash }
```

No new tests required — additive boolean. Run full backend `bun test` to confirm no regression.

Commit: `feat(auth): expose hasPassword on session response`

---

## Task 4: i18n keys

**Files:**
- Modify: `src/ui/i18n.ts`

Add to the `en` block (after existing `dash.signOut` or similar nearby key):

```ts
"dash.changePassword": "Change Password",
"dash.changePasswordTitle": "Change your password",
"dash.oldPassword": "Current password",
"dash.newPassword": "New password",
"dash.confirmNewPassword": "Confirm new password",
"dash.changePasswordSubmit": "Update password",
"dash.passwordMinLength": "Password must be at least 6 characters",
"dash.passwordMismatch": "New passwords do not match",
"dash.passwordIncorrect": "Current password is incorrect",
"dash.passwordSameAsOld": "New password must differ from the current one",
"dash.changePasswordErrEmpty": "All fields are required",
"dash.changePasswordErrOAuth": "This account uses OAuth sign-in",
"dash.changePasswordErrGeneric": "Failed to change password",
"dash.passwordChangedToast": "Password changed",
```

And to the `zh` block, mirroring keys:

```ts
"dash.changePassword": "修改密码",
"dash.changePasswordTitle": "修改密码",
"dash.oldPassword": "当前密码",
"dash.newPassword": "新密码",
"dash.confirmNewPassword": "确认新密码",
"dash.changePasswordSubmit": "更新密码",
"dash.passwordMinLength": "密码长度至少 6 位",
"dash.passwordMismatch": "两次输入的新密码不一致",
"dash.passwordIncorrect": "当前密码不正确",
"dash.passwordSameAsOld": "新密码不能与当前密码相同",
"dash.changePasswordErrEmpty": "请填写所有字段",
"dash.changePasswordErrOAuth": "该账号通过 OAuth 登录，无密码可改",
"dash.changePasswordErrGeneric": "修改密码失败",
"dash.passwordChangedToast": "密码已更新",
```

Verify counts match between blocks.

Commit: `i18n(dashboard): change-password strings`

---

## Task 5: client.ts state + methods

**Files:**
- Modify: `src/ui/dashboard/client.ts`

Add reactive state near other auth state (search for `isAdmin:` in the data section):

```js
hasPassword: false,
changePasswordOpen: false,
cpOldPassword: '',
cpNewPassword: '',
cpConfirmPassword: '',
cpError: '',
cpSubmitting: false,
```

In whatever method handles the `/auth/login` response (search `await fetch('/auth/login'` or where `isAdmin` is assigned), add:

```js
this.hasPassword = !!data.hasPassword;
```

Add three methods as siblings to existing methods (anywhere reasonable, e.g. near `signOut`):

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
    try { const data = await resp.json(); serverError = (data && data.error) || ''; } catch (_e) {}
    const lower = serverError.toLowerCase();
    if (resp.status === 401 && lower.includes('incorrect')) {
      this.cpError = this.t('dash.passwordIncorrect');
    } else if (resp.status === 400 && lower.includes('oauth')) {
      this.cpError = this.t('dash.changePasswordErrOAuth');
    } else if (resp.status === 400 && lower.includes('different')) {
      this.cpError = this.t('dash.passwordSameAsOld');
    } else if (resp.status === 400 && lower.includes('6 characters')) {
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

Commit: `feat(dashboard): change-password modal state and submit`

---

## Task 6: Dropdown item + modal template

**Files:**
- Modify: `src/ui/dashboard/tabs.ts`

### A. Insert menu item

In the user-menu dropdown (~lines 53–68), insert between Settings and Sign Out:

```html
<button
  type="button"
  x-show="hasPassword"
  @click="openChangePasswordModal(); userMenuOpen = false"
  class="w-full text-left px-4 py-2 text-sm text-themed-dim hover:text-themed hover:bg-surface-700 transition-colors cursor-pointer bg-transparent border-0"
  x-text="t('dash.changePassword')"
></button>
```

### B. Append modal at top-level (near the end of the template, after other top-level overlays)

```html
<!-- Change Password Modal -->
<div
  x-show="changePasswordOpen"
  x-transition.opacity
  class="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
  @click.self="closeChangePasswordModal()"
  @keydown.escape.window="closeChangePasswordModal()"
  style="display: none;"
>
  <div class="glass-card p-6 w-full max-w-sm" @click.stop>
    <h3 class="text-base font-semibold mb-4" x-text="t('dash.changePasswordTitle')"></h3>
    <div class="space-y-3">
      <div>
        <label class="text-xs text-themed-dim block mb-1" x-text="t('dash.oldPassword')"></label>
        <input type="password" x-model="cpOldPassword" @input="cpError = ''" class="!text-xs !py-1.5 !px-3 w-full !rounded-lg" :disabled="cpSubmitting" />
      </div>
      <div>
        <label class="text-xs text-themed-dim block mb-1" x-text="t('dash.newPassword')"></label>
        <input type="password" x-model="cpNewPassword" @input="cpError = ''" class="!text-xs !py-1.5 !px-3 w-full !rounded-lg" :disabled="cpSubmitting" />
      </div>
      <div>
        <label class="text-xs text-themed-dim block mb-1" x-text="t('dash.confirmNewPassword')"></label>
        <input type="password" x-model="cpConfirmPassword" @input="cpError = ''" @keydown.enter.prevent="submitChangePassword()" class="!text-xs !py-1.5 !px-3 w-full !rounded-lg" :disabled="cpSubmitting" />
      </div>
      <p x-show="cpError" x-text="cpError" class="text-xs text-red-400"></p>
    </div>
    <div class="flex justify-end gap-2 mt-5">
      <button type="button" @click="closeChangePasswordModal()" class="btn-ghost text-xs" :disabled="cpSubmitting" x-text="t('dash.cancel')"></button>
      <button type="button" @click="submitChangePassword()" class="btn-primary !text-xs !py-1.5 !px-3" :disabled="cpSubmitting || !cpOldPassword || !cpNewPassword || !cpConfirmPassword" x-text="t('dash.changePasswordSubmit')"></button>
    </div>
  </div>
</div>
```

Commit: `feat(dashboard): change-password menu item and modal`

---

## Task 7: Final verification

- `bun test tests/auth-change-password.test.ts` → 7 pass
- `bun test tests/key-sharing.test.ts` → 10 pass (regression)
- Manually verify: OAuth account sees no menu item; email account sees and can change.
