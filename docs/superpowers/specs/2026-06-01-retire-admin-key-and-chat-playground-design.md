# Retire ADMIN_KEY + Chat Playground — Design Spec

**Date:** 2026-06-01
**Scope:** Two sequential sub-projects on one branch:
1. **Sub-project A — Retire `ADMIN_KEY`**: collapse the system to a single identity model where the only authenticated principals are logged-in users (session token or their own API key), and "admin" is just a flag on a user whose email is in `ADMIN_EMAILS`.
2. **Sub-project B — Chat Playground**: a new Models tab inside the dashboard that lets a logged-in user (admin or not) self-test `/v1/chat/completions` and `/v1/messages` against any model their upstreams expose, using one of their own API keys as the credential.

Sub-project A must land before Sub-project B because B's auth assumption ("only logged-in users exist; admin is just a tag") depends on A being done.

---

## Sub-project A: Retire `ADMIN_KEY`

### Why

Today the codebase carries two parallel admin notions:
- **A magic string** in `env.ADMIN_KEY` that any client can present as Bearer to get full control-plane privileges.
- **An email allowlist** `ADMIN_EMAILS` that promotes a logged-in user to admin.

Only the email-allowlist mechanism is needed. The magic-string mechanism is legacy, mostly dead, and one of its leftover behaviors is reusing the same secret as the signature key for shared-view URLs (`getServerSecret`) — conceptually wrong, because a management credential and a URL signing key are different things.

Removing `ADMIN_KEY` collapses the model to "there is one kind of authenticated principal: a logged-in user; some users have `isAdmin = true`."

### Decisions

#### A1. First admin user on a fresh deployment

- **Local (`src/local.ts`)**: on startup, if `users` is empty, seed a deterministic admin user (`email = TEST_EMAIL` = `"test@local.dev"` — local-only account; still in `ADMIN_EMAILS` so it gets `isAdmin = true`; fixed UUID `00000000-0000-0000-0000-000000000001`, name `"Local Admin"`) and set its password hash from a **hard-coded** constant `LOCAL_DEV_PASSWORD = "local-dev-admin"`. Print a single log line on startup: `🔑 Local admin login: test@local.dev / local-dev-admin (dev only)`.
- **CFW (`src/index.ts`)**: do **not** seed anything. The first admin signs in via Google OAuth using an email in `ADMIN_EMAILS`. There is no other way in.

#### A2. Four cleanup sites

**A2a — `src/lib/redact-shared-view.ts:getServerSecret`**
- Drop the `env.ADMIN_KEY` fallback rung.
- Add a startup contract: in CFW mode, `SERVER_SECRET` must be set; if it is missing, throw at first call site with `"SERVER_SECRET must be set"`.
- In local mode (`src/local.ts` bootstrap), if `process.env.SERVER_SECRET` is unset, set it programmatically to the constant `"local-dev-server-secret"` and log one warning line `⚠️ SERVER_SECRET unset; using local dev default (dev only)`.

**A2b — `src/routes/auth/sessions.ts`**
- Delete the `if (adminKey && sessionToken === adminKey)` branch (currently lines ~27-31). The session-validate endpoint no longer recognises `ADMIN_KEY` as a session token.

**A2c — `src/index.ts` and `src/local.ts` auth middleware**
- Delete both `ADMIN_KEY` branches in each file (the `/auth/*` path and the main path). After removal, the auth middleware understands exactly three kinds of credentials: session token (`ses_*`), API key (`sk_*`), and unauthenticated.

#### A3. Local seed password source

Replace `await hashPassword(env.ADMIN_KEY)` at `src/local.ts:343` with `await hashPassword(LOCAL_DEV_PASSWORD)` where `LOCAL_DEV_PASSWORD` is the module-level constant introduced in A1.

#### A4. Env / type cleanup

- Remove `ADMIN_KEY: string` from `LocalEnv` (`src/local.ts`) and `ADMIN_KEY?: string` from `Env` (`src/lib/state.ts`).
- Remove `ADMIN_KEY: process.env.ADMIN_KEY || "xuangong123!"` from `src/local.ts`. (The hard-coded `"xuangong123!"` string is also deleted — replaced by the `LOCAL_DEV_PASSWORD` constant from A3, which is `"local-dev-admin"`.)

### Out of scope for Sub-project A

- No changes to `ADMIN_EMAILS` content or location.
- No changes to invite-code or Google OAuth flows.
- No migration of historical data; once deployed, any consumer still bearing the old `ADMIN_KEY` Bearer simply gets 401.

---

## Sub-project B: Chat Playground

### Why

The dashboard cannot self-test whether a configured upstream actually serves chat traffic. Today a user must leave the dashboard, copy an API key, paste it into curl or a third-party tool, and craft a request manually. This makes routine upstream debugging slow and breaks the "self-contained" property of the product.

The playground reuses the existing data-plane routes (`/v1/chat/completions`, `/v1/messages`) so what is tested is what production sees — no bespoke playground-only path.

### Decisions

#### B1. Credential

The playground sends requests from the dashboard browser using **the logged-in user's own API key**. No new auth surface is added; the backend is unchanged. The user picks which of their keys to use via a top-of-tab dropdown (decision B3).

This is consistent with Sub-project A's premise: admins are just users, so they too test using a key they have created.

#### B2. Empty state (user has no API keys)

The Models tab shows an empty-state card: title "No API key", body "You need at least one API key to use the playground", and a primary button "Create one in Keys" that switches the dashboard hash to `#keys`. The card replaces both the model list and chat panel.

The Models tab does not embed any key-creation form — that responsibility stays in the Keys tab.

#### B3. API key selection (user has ≥1 key)

Top of the Models tab: a small dropdown labeled "Send with key", listing the user's own enabled keys sorted by `createdAt` ascending. The default selection is `localStorage["playground.keyId"]` if it still references an existing enabled key, otherwise the first item. Changing the selection persists to localStorage and does **not** clear the current chat.

Single-key users see a dropdown with one item — visually present but trivially used.

#### B4. Model list

Source: `/v1/models` with the user's selected playground key as the credential. The endpoint already returns one entry per (model id, winning upstream) pair, with `_upstream` and `_provider` provenance fields injected by the registry.

Layout:
- **Left column** (≈288px on desktop): a scrollable list of models **grouped by `_upstream`**. Each group has a collapsible header showing the upstream id and the number of models in it. All groups open by default. Within a group, models are sorted by `id` ascending. A search box at the top of the left column filters models by a case-insensitive substring match against `id` or `displayName`; groups whose models all filter out are hidden.
- **Right column**: chat panel for the currently selected model (decision B5). If nothing is selected, show centered text "Select a model to begin".

The first model in the first non-empty group is auto-selected on tab mount.

#### B5. Chat panel — protocol selection

A top-of-panel segmented control with two options: **OpenAI** (`POST /v1/chat/completions`) and **Anthropic** (`POST /v1/messages`). Default to OpenAI. Switching protocols **clears the current chat** (the conversation is scratch space and the two protocols use different request bodies).

Choosing the protocol is explicit, not auto-inferred from model id — testing whether a Claude model still answers a `/v1/chat/completions` call (or vice versa) is a core playground use case.

#### B6. Message content

- **Text**: required. A multi-line textarea above the send button.
- **System prompt**: an optional collapsible "System" panel above the chat area. When non-empty, the system text is included on every request as either `messages[0]` (OpenAI) or the `system` top-level field (Anthropic). Editing the system text does not clear existing messages.
- **Images** (per message):
  - Two input modes coexist on the same message-compose row:
    - **URL**: a plain text input "Image URL (public)". The string is sent verbatim as `image_url.url` for OpenAI, or as `source.url` for Anthropic (Anthropic's URL form is supported on its `/v1/messages`).
    - **Local file**: a file picker that accepts `image/*`. The chosen file is read by `FileReader.readAsDataURL` and the resulting `data:image/<mime>;base64,…` string is used in the same `image_url.url` (OpenAI) or as a base64 `source` block (Anthropic).
  - Files larger than **5 MB** are rejected on the client with an inline error "Image too large (max 5 MB)" — no upload is attempted.
  - At most one image per outbound message (sent as the trailing item of a `content` array alongside any text).
- **Tools**: not supported in this version. The request never includes a `tools` field; assistant responses containing `tool_use` blocks render as raw JSON inside the assistant bubble.

#### B7. Streaming, cancel, clear

- Both protocols are called with `stream: true` and parsed incrementally:
  - **OpenAI**: line-based SSE; `data: <json>`; `[DONE]` ends. Append `choices[0].delta.content` to the current assistant bubble.
  - **Anthropic**: SSE with named events; consume `content_block_delta` (`delta.text`) to append; `message_stop` ends.
  - On either protocol, an error event (`{error: {message}}` for OpenAI, `event: error` for Anthropic) ends the stream and appends `[Error] <msg>` to a new assistant bubble.
- An `AbortController` is created per send. A **Stop** button is visible only while a request is in flight and aborts the fetch.
- A **Clear** button (always visible) aborts any in-flight request and empties the message list. The system prompt is **not** cleared.
- The chat is **automatically cleared** when the selected model id or the selected protocol changes. Switching the API key only rebinds the credential and does **not** clear the chat.
- The chat is **not** persisted across reloads; reloading the page empties it.

#### B8. Tab registration

`Models` is added to `ALL_TABS` in `src/ui/dashboard-app/App.tsx`. It is visible to **both admin and non-admin** users. Hash route: `#models`. `TabBody` switches on `"models"` and renders `<ModelsTab />`.

#### B9. i18n

Add new keys under the `dash.models*` and `dash.playground*` namespaces in `src/ui/i18n.ts` for both English and Chinese locales (sample keys: `dash.models`, `dash.playground.noKey`, `dash.playground.createKey`, `dash.playground.sendWithKey`, `dash.playground.searchModels`, `dash.playground.system`, `dash.playground.stop`, `dash.playground.clear`, `dash.playground.imageTooLarge`, `dash.playground.selectModel`). Tab label key: `dash.models`.

### Out of scope for Sub-project B

- No model favorites, recently-used list, or per-model parameter presets.
- No conversation persistence, export, or sharing.
- No tool/function call testing (deferred; tool_use blocks render raw).
- No streaming token counts or latency display in the chat itself (latency is already in the Latency tab).
- No request/response inspector (deferred — `Network` tab in DevTools is the workaround).

---

## File structure

### Sub-project A files

- Modify: `src/index.ts` — delete two `ADMIN_KEY` branches
- Modify: `src/local.ts` — delete two `ADMIN_KEY` branches; introduce `LOCAL_DEV_PASSWORD` constant; rewrite seed-user hash source; remove `ADMIN_KEY` from `LocalEnv` and env construction; programmatic `SERVER_SECRET` fallback for local
- Modify: `src/lib/state.ts` — remove `ADMIN_KEY?` from `Env`
- Modify: `src/lib/redact-shared-view.ts` — `getServerSecret` strict mode (throws if unset in CFW)
- Modify: `src/routes/auth/sessions.ts` — delete `ADMIN_KEY === sessionToken` branch
- Tests: extend `tests/auth.test.ts` (or equivalent) to assert that an `ADMIN_KEY`-style Bearer is rejected and that a session-token user with admin email is accepted on `/api/*`

### Sub-project B files

- Create: `src/ui/dashboard-app/tabs/models/ModelsTab.tsx` — left list + right panel layout, model fetching, search, group rendering, key dropdown, empty state
- Create: `src/ui/dashboard-app/tabs/models/ChatPanel.tsx` — message list, compose row, protocol radio, system panel, send / stop / clear logic, streaming dispatcher
- Create: `src/ui/dashboard-app/tabs/models/streams/openai.ts` — OpenAI SSE parser (text-only)
- Create: `src/ui/dashboard-app/tabs/models/streams/anthropic.ts` — Anthropic SSE parser (text-only)
- Create: `src/ui/dashboard-app/tabs/models/image.ts` — file-to-data-URL helper with 5 MB guard
- Modify: `src/ui/dashboard-app/App.tsx` — register `models` tab in `ALL_TABS` and `TabBody`
- Modify: `src/ui/dashboard-app/api/models.ts` (create if missing) — typed wrapper around `/v1/models` that forwards the playground key as `x-api-key`
- Modify: `src/ui/i18n.ts` — add `dash.models*` / `dash.playground.*` keys for `en` and `zh`
- Tests: component-level tests for `image.ts` (mime, size guard) and the two stream parsers (golden SSE fixtures → expected delta sequence)

## Testing strategy

- **Sub-project A** is primarily a *removal* — main risk is collateral break. Required tests:
  - Auth middleware unit tests: bearer `<old admin key value>` → 401 on both `/api/*` and `/v1/*`.
  - Session validate unit test: presenting a non-session non-API string returns "No session".
  - Bootstrap test (local): repo with empty users → after bootstrap, `findByEmail(ADMIN_EMAILS[0])` returns a user, and `verifyPassword("local-dev-admin", hash)` is true.
  - `getServerSecret` test: CFW shape (no `SERVER_SECRET`, no `ADMIN_KEY`) throws; local shape resolves the dev default.

- **Sub-project B** unit tests focus on the parts with logic, not the JSX shell:
  - `image.ts`: 4 MB image → returns data URL with correct MIME; 6 MB image → throws with the localized error key.
  - `streams/openai.ts`: feeds a fixture (`data: {...}\n\n` × 3 + `data: [DONE]`) → emits expected text deltas; malformed JSON line skipped; error event surfaces as throw.
  - `streams/anthropic.ts`: feeds a fixture spanning `message_start` → multiple `content_block_delta` → `message_stop` → emits expected deltas; `event: error` surfaces as throw.
  - `ModelsTab`: with mocked fetch returning two models on two upstreams → both groups render with correct counts; search "claude" filters to only matching rows.

- **Manual smoke** after deploy: log in as a non-admin user with one API key; open Models tab; send "hi" to a Copilot model in OpenAI mode and again in Anthropic mode against a Claude model; upload a 1 MB JPG and ask the model to describe it; click Stop mid-stream; click Clear; switch models — confirm chat clears.
