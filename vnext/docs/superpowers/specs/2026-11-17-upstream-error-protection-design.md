# Upstream error protection: error statistics, flood detection and automatic pauses

Status: implemented on branch feat/upstream-protection (2026-11-17).

## Motivation

The gateway forwards model requests to upstream accounts (GitHub Copilot, Loki, and others). Upstream providers watch account behaviour: a burst of rate-limit (429), rejected (400, e.g. content filter or invalid request) or authentication (401/403) responses can get an account throttled, forced to re-authenticate, or suspended. Today the gateway only records a success/failure flag per request (`performance_summary`, hourly), so the owner can neither see what kind of errors an upstream returns nor stop a flood before it harms the account.

The owner wants to:

- see error statistics per upstream, by error class, over time, with samples of the actual error messages;
- be told prominently when an upstream receives an abnormal flood of risky errors;
- optionally have the gateway pause the culprit automatically to protect the account.

## Decisions

- **Error statistics are always recorded**, for every upstream, regardless of protection settings.
- **Protection is opt-in per upstream**, with three modes: `off` (default), `notify` (warn only), `pause` (warn and pause automatically).
- **Automatic pauses resume automatically** after a cooldown; the owner can resume early.
- **Attribution:** when one API key causes at least 80% of an upstream's risky errors in the window, the whole key is paused (on every upstream); otherwise the upstream is paused.
- **Thresholds are configurable per upstream**, with defaults.
- **Placement:** a global banner on every dashboard page, protection status / statistics / samples / history on the Upstream page, and a badge on paused keys on the API Keys page.
- No email or chat notifications.

## Error classes

Every response to a request the gateway sent to an upstream is classified:

| class | meaning | risky |
| --- | --- | --- |
| `ok` | 2xx | no |
| `rate_limited` | 429 | yes |
| `rejected` | 400, 404, 409, 413, 422 (invalid request, content filter, unknown model, too large) | yes |
| `auth` | 401, 403 | yes |
| `upstream` | 5xx | no |
| `network` | no HTTP response: connect error, timeout, reset | no |
| `other` | any other status | no |

Only requests that reached the upstream count. Requests the gateway rejects itself (bad API key, quota, validation, no route) are not recorded here. A streamed response that starts with 2xx and fails mid-stream counts as `ok` (the account was not refused).

## Data

Migration `0027_upstream_protection.sql`, shared by D1 and SQLite.

`upstream_request_minutes` — one row per (minute, upstream, key, model):

| column | |
| --- | --- |
| `minute` | unix seconds, start of the minute |
| `upstream_id`, `key_id`, `model` | dimensions |
| `requests` | all recorded requests |
| `rate_limited`, `rejected`, `auth`, `upstream`, `network`, `other` | counts per class |

Primary key `(upstream_id, minute, key_id, model)`; index on `minute` for retention and on `(key_id, minute)` for key queries. Written with one upsert per upstream response (`INSERT … ON CONFLICT DO UPDATE SET requests = requests + 1, <class> = <class> + 1`). Retention 30 days.

`upstream_error_samples` — the latest 20 per (upstream, status):

| column | |
| --- | --- |
| `upstream_id`, `status` (HTTP status, 0 for network), `at` (unix ms), `key_id`, `model` | |
| `code` | the upstream's error type/code when its body has one (e.g. `rate_limit_exceeded`), else empty |
| `message` | the upstream's error message, trimmed to 300 characters; for network errors the gateway's error name |

Written only for risky classes and `upstream`/`network`; older rows beyond 20 per (upstream, status) are deleted in the same batch. The request and response content is never stored, only the upstream's error description.

`protection_pauses`:

| column | |
| --- | --- |
| `id` | `pp_` + 32 hex |
| `target_kind` | `upstream` or `key` |
| `target_id` | |
| `upstream_id` | the upstream whose errors triggered it |
| `mode` | `pause` or `notify` (a `notify` row records a warning, not a block) |
| `reason_json` | window, counts per class, failure ratio, top 5 keys with counts, threshold that fired |
| `started_at`, `ends_at` | unix ms; `ends_at` is the cooldown end (for `notify`, the warning's display end) |
| `resolved_at`, `resolved_by` | when and how it ended early: `auto` (cooldown), `owner` (resumed in dashboard) |

Retention 90 days. Active = `resolved_at IS NULL AND ends_at > now`.

Upstream settings gain `protection`:

```ts
protection?: {
  mode: "off" | "notify" | "pause"  // default "off"
  windowMinutes: number              // default 5, 1..60
  minRiskyErrors: number             // default 20, 1..10000
  minFailureRatio: number            // default 0.5, 0..1 (risky errors / requests in the window)
  authBurst: number                  // default 5, 0 disables; auth errors alone that trigger
  keyShare: number                   // default 0.8, 0.5..1; share of risky errors that attributes to one key
  cooldownMinutes: number            // default 30, 1..1440
  maxCooldownMinutes: number         // default 360
}
```

## Detection

After recording a risky response, the gateway evaluates the upstream (only if its mode is not `off`), at most once every 10 seconds per upstream per isolate/process:

1. Sum `upstream_request_minutes` for the upstream over the last `windowMinutes` (whole minutes including the current one; when the owner resumed a pause or warning of this upstream or one of its keys inside the window, the window starts at the minute after the resume, so earlier errors cannot pause it again): requests, risky errors, auth errors, and risky errors per key.
2. Trigger when (risky ≥ `minRiskyErrors` and risky / requests ≥ `minFailureRatio`) or (`authBurst` > 0 and auth ≥ `authBurst`).
3. Skip if an active pause or warning already covers this upstream or its attributed key.
4. Target: the key with the largest risky count if its share ≥ `keyShare` and at least two distinct API keys sent requests in the window, else the upstream (with one key, pausing the key would lock the owner out of the upstream anyway).
5. Cooldown: `cooldownMinutes`, doubled for each earlier pause of the same target and same mode that started within the last 24 hours, capped at `maxCooldownMinutes`.
6. Insert a `protection_pauses` row with `mode` = the upstream's mode.

An auth rejection (401/403) that the provider cured by refreshing its credential and replaying the request is recorded as `other`, not `auth`: the caller never saw it. A final 401/403, and a Codex `token_invalidated` (the request is replaced by a gateway 503), stay `auth`.

Evaluation happens on the request path but after the response has been handed to the client (`waitUntil` on Workers); its failure never affects the request.

## Enforcement

- Active `pause` rows are read through a per-isolate cache refreshed at most every 10 seconds (one indexed query). A new pause is therefore effective everywhere within about 10 seconds; the isolate that created it applies it at once.
- A paused upstream is skipped during routing like a disabled one. If no other upstream can serve the request, the gateway answers `503` with `Retry-After` (seconds until `ends_at`) and error code `upstream_paused`, naming the upstream and the time it resumes.
- A paused key gets `503` with `Retry-After` and error code `key_paused` on every request, before any upstream is called.
- `notify` rows never block.
- Paused-request rejections are not recorded in `upstream_request_minutes` (they never reached the upstream).

## API (session-guarded, owner-only like upstream management)

- `GET /api/protection/active` → active pauses and warnings (for the banner).
- `POST /api/protection/pauses/:id/resume` → resolves with `resolved_by = owner`.
- `GET /api/upstreams/:id/errors?from=&to=&bucket=minute|hour` → per-bucket counts per class (and requests), optionally `keyId=`; at most 30 days, at most 1500 buckets.
- `GET /api/upstreams/:id/error-samples` → latest samples per status.
- `GET /api/upstreams/:id/pauses?limit=` → pause history.
- Upstream settings `PATCH` accepts `protection` (validated against the ranges above).

## Dashboard

- **Global banner** (all pages) while any pause or warning is active: "Upstream *X* paused until 18:40 — 46 rate-limit errors in 5 min (92% of requests)." or "API key *Y* paused …"; `notify` rows read "Upstream *X* is receiving an error flood …". Each has *Resume now* (for pauses) and a link to the upstream's protection section. Refreshed every 60 seconds and after actions.
- **Upstream page**, per upstream, a Protection section:
  - mode selector (off / notify / pause) and threshold fields with defaults shown;
  - current state (normal / paused until … / warning until …);
  - error chart: stacked bars per class with requests as a line, ranges 1 h (by minute) and 24 h / 7 d / 30 d (by hour), local time; risky classes in warm colours;
  - error samples: status, code, message, time, key, model;
  - pause history: target, reason summary, start, end, how it ended.
- **API Keys page:** a "Paused until …" badge on paused keys with the reason in a tooltip and a Resume action.
- All copy in EN and ZH; times in the browser's local time.

## Retention

Scheduled maintenance deletes `upstream_request_minutes` older than 30 days, `protection_pauses` older than 90 days, and samples whose upstream no longer exists, in bounded chunks like the existing sweeps.

## Testing

- Classification of statuses and network errors; mid-stream failures count as `ok`; gateway-side rejections not recorded.
- Repo contract (SQLite and D1): minute upsert, window sums, samples trimmed to 20, pause insert/active/resolve, retention.
- Detection: each threshold boundary, ratio, auth burst, key attribution at the share boundary, cooldown doubling and cap, no duplicate pause while one is active, `off` never evaluates, `notify` never blocks, evaluation throttle.
- Enforcement: paused upstream skipped with fallback to another upstream; `503 upstream_paused` with `Retry-After` when none remains; `503 key_paused`; resume restores service; cache refresh.
- API: owner-only, validation, resume.
- Dashboard: banner wording and actions, protection form validation, chart data shaping, samples and history tables, key badge, EN/ZH parity.
- Acceptance: `bun run ci:local` with no failures beyond the known baseline.

## Rollout

Merge, push, apply migration 0027 to D1, deploy the Worker; rebuild local gateways. Protection stays `off` until the owner enables it per upstream; statistics start immediately.

## Out of scope

Notifications outside the dashboard, per-model pauses, pausing a key only on one upstream, learning thresholds automatically, storing request or response content.
