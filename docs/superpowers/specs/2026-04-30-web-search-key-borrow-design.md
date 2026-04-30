# Web-Search Key Borrow References — Design

Date: 2026-04-30
Status: Approved (pending implementation)

## Problem

Today, an api_key's web-search engine secrets (LangSearch, Tavily, Microsoft
Grounding) are stored as literal values per key. The `copy-web-search-from`
endpoint duplicates those literals onto the target key. Two consequences:

1. The same secret is now stored twice; rotating the source key does not
   propagate.
2. The borrower's owner — or anyone who can read the borrower's masked key
   listing — implicitly receives a copy of the secret. We want "borrowed, not
   owned" semantics: the borrower can *use* the secret but cannot *retrieve*
   it.

## Goals

- Each engine key field on an api_key is either a literal, or a reference to
  another api_key that holds the literal.
- The reference is resolved server-side at request time; the literal is never
  returned to the borrower's owner.
- Visibility is re-checked on every resolve. If the source disappears or the
  borrower loses access, the engine is silently skipped.
- A user can borrow from any api_key visible to them in the dashboard at the
  time of resolution.

## Non-goals

- Borrowing the Bing or Copilot engines (Bing has no key; Copilot uses the
  per-key GitHub session, which is not a copyable secret).
- Transitive references (A → B → C). Source must hold a literal value.
- Audit log of who borrowed from whom (out of scope; can be added later).

## Schema

Migration `migrations/0021_api_key_web_search_refs.sql`:

```sql
ALTER TABLE api_keys ADD COLUMN web_search_langsearch_ref TEXT;
ALTER TABLE api_keys ADD COLUMN web_search_tavily_ref TEXT;
ALTER TABLE api_keys ADD COLUMN web_search_ms_grounding_ref TEXT;
```

Each `*_ref` column holds the source `api_keys.id`. Invariant enforced at
the PATCH layer: for any given engine, at most one of the literal column or
the ref column is non-null. Setting one server-side clears the other.

`ApiKey` interface gains:

```ts
webSearchLangsearchRef?: string
webSearchTavilyRef?: string
webSearchMsGroundingRef?: string
```

Both SQLite and D1 repos load and persist these alongside existing fields.

## Resolution

A new helper in `src/services/web-search/core.ts`:

```ts
async function resolveWebSearchKeys(
  keyConfig: ApiKey,
  borrowerOwnerId: string | undefined,
  envMsGroundingKey?: string,
): Promise<{ langsearchKey?: string; tavilyKey?: string; msGroundingKey?: string }>
```

For each of the three engines:

1. If literal field is set → use it.
2. Else if `*_ref` is set → fetch source api_key by id.
   - If source missing → undefined.
   - **Re-check visibility now**: borrower's `ownerId` must still pass the
     same dashboard listing rules used by `GET /api/keys` (same owner, OR
     borrower has key-assignment to source's owner, OR observability share
     grants visibility). If not visible → undefined.
   - If source's matching literal field is unset (or itself a ref) →
     undefined.
   - Otherwise → use source's literal.
3. Else (msGrounding only) → fall back to env-level `msGroundingKey`.

Engines whose key ends up undefined are silently skipped by
`EngineManager.tryBuild`.

## Wiring resolution into every route

`loadWebSearchConfig` (in `src/services/web-search/core.ts`) calls
`resolveWebSearchKeys` instead of reading the three literal fields directly.
Used by: `chat-completions.ts`, `responses.ts`, `gemini.ts`.

**`messages.ts` does not use `loadWebSearchConfig`** — it inlines the
`engineOptions` block at `src/routes/messages.ts:118`. As part of this work
that block is replaced with a call to the same `resolveWebSearchKeys` helper
so all four SDK routes share one resolution path. (This also folds in the
already-pending `priority` wiring from migration 0020.)

## API surface

All field names use **snake_case** to match the existing
`/api/keys` PATCH/GET wire format.

### `GET /api/keys` (and per-id variants)

For each engine, exactly one of the following appears in the response:

```jsonc
// Literal (existing behavior — masked):
"web_search_langsearch_key": "lsk-***abcd",
"web_search_langsearch_ref": null

// Healthy ref (source visible, holds literal):
"web_search_langsearch_key": null,
"web_search_langsearch_ref": { "id": "...", "name": "Prod search", "owner_id": "u_..." }

// Broken ref (source missing or no longer visible):
"web_search_langsearch_key": null,
"web_search_langsearch_ref": { "id": "<storedRefId>", "name": null, "owner_id": null, "broken": true }
```

The ref descriptor never carries the source's literal value. UI renders
broken refs as `↗ (unavailable)` with an Unlink button.

### `PATCH /api/keys/:id`

Per engine, three new optional fields are accepted alongside today's:

- `web_search_langsearch_key: string | null`  — set/clear literal (existing)
- `web_search_langsearch_ref:  string | null` — set/clear ref to source key id (new)
- ... and matching pairs `web_search_tavily_*`, `web_search_ms_grounding_*`.

Behavior:

- If both `*_key` and `*_ref` are present in the body for the same engine
  → 400.
- Setting `*_ref` to a non-null value:
  - 404 if source id does not exist.
  - 400 if source is not visible to the caller per dashboard rules.
  - On success: writes ref column, clears the matching `*_key` column.
- Setting `*_key` to a non-null value: clears the matching `*_ref` column.
- `null` clears the field it targets and leaves the other untouched.

### `POST /api/keys/:id/copy-web-search-from/:sourceId`

Refactored: the three secret literal fields are no longer copied; instead,
the corresponding `*_ref` columns on the target are set to `sourceId`.
Everything else keeps copying as today (`webSearchEnabled`,
`webSearchBingEnabled`, `webSearchCopilotEnabled`, `webSearchCopilotPriority`,
`webSearchPriority`). New behavior summarized:

```ts
updated = {
  ...target,
  webSearchEnabled: source.webSearchEnabled,
  webSearchBingEnabled: source.webSearchBingEnabled,
  webSearchCopilotEnabled: source.webSearchCopilotEnabled,
  webSearchCopilotPriority: source.webSearchCopilotPriority,
  webSearchPriority: source.webSearchPriority,
  // Secrets become refs. If source itself holds a ref or no value,
  // leave target's field empty (do not copy ref-of-ref).
  webSearchLangsearchKey: undefined,
  webSearchLangsearchRef: source.webSearchLangsearchKey ? sourceId : undefined,
  webSearchTavilyKey: undefined,
  webSearchTavilyRef: source.webSearchTavilyKey ? sourceId : undefined,
  webSearchMsGroundingKey: undefined,
  webSearchMsGroundingRef: source.webSearchMsGroundingKey ? sourceId : undefined,
}
```

## Dashboard

Each engine key input gains a "Borrow from…" affordance:

- Click → opens a picker listing api_keys visible to the user that have a
  literal value for that engine. Items show key name + owner name.
- Pick a source → input becomes read-only and renders `↗ <sourceKeyName>`,
  with an "Unlink" button that PATCHes `*_ref: null`.
- Broken ref renders as `↗ (unavailable)` with the same Unlink button.
- "Unlink" makes the input editable again, empty.

i18n strings added in `src/ui/i18n.ts`: `wsBorrowFrom`, `wsBorrowedFrom`,
`wsBorrowedUnavailable`, `wsUnlink`, `wsBorrowPickerTitle`.

## Tests

Unit (`tests/web-search-borrow.test.ts`):

- `resolveWebSearchKeys` —
  - literal-only,
  - ref resolves to source literal when borrower has visibility,
  - ref to missing source returns undefined,
  - ref to source-that-also-has-ref returns undefined (no transitive),
  - ref to source whose literal is unset returns undefined,
  - ref where borrower has lost visibility returns undefined.

Route (`tests/api-keys-borrow.test.ts`):

- PATCH with both literal and ref for same engine → 400.
- PATCH with ref to invisible key → 400.
- PATCH with ref to missing key → 404.
- PATCH with valid ref clears the literal column (and vice versa).
- GET response for borrower never includes source's value, only the ref
  descriptor. Healthy and broken descriptors render correctly.
- copy-web-search-from sets `*_ref` columns, clears `*_key` columns, and
  preserves the other flags + priority.

Integration (`tests/web-search-borrow-integration.test.ts`):

- Anthropic /v1/messages (the inlined route) honors refs.

## Open questions resolved

- **Visibility scope**: any key the dashboard user can see at request time
  (owner + key-assignments + observability shares). Re-checked on every
  resolve.
- **Broken refs**: silently skip at the engine layer; surface a
  `{ broken: true }` descriptor in the API/UI so the borrower can clean up.
- **Transitive refs**: not supported. Source must hold a literal.
- **Wire format**: snake_case, matches existing `/api/keys` API.
- **copy-from semantics**: only the three secret-literal fields become refs;
  flags, copilot/bing settings, and priority continue to be copied as today.
