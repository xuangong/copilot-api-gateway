# Upstream error protection (v1)

Reference for operators. Design: `docs/superpowers/specs/2026-11-17-upstream-error-protection-design.md`; plan: `docs/superpowers/plans/2026-11-17-upstream-error-protection.md`.

## What is recorded

Every response (or transport failure) of a request the gateway sends to an upstream is counted per minute, upstream, API key and model, by class. Attempts the provider retries or replaces are counted too, by their own class.

| class | statuses | risky |
| --- | --- | --- |
| `ok` | 2xx (a stream that fails after a 2xx start still counts as `ok`) | no |
| `rate_limited` | 429 | yes |
| `rejected` | 400, 404, 409, 413, 422 | yes |
| `auth` | 401, 403 | yes |
| `upstream` | 5xx | no |
| `network` | no HTTP response: connect error, timeout, reset | no |
| `other` | anything else | no |

Covered: chat completions, messages, responses and Gemini requests (all through the three hub attempts), embeddings and images. Statistics are recorded whatever the protection mode.

Not recorded:

- Responses the gateway or a provider builds itself without contacting the upstream (for example the codex, claude-code and copilot synthetic 400/429/503 answers), requests the gateway rejects (bad key, quota, validation, no route, paused), caller aborts.
- Call types not covered in v1 (they still reach upstream accounts): `count_tokens` (messages, Gemini), `decision` routes, `alpha/search`, image-generation server-tool sub-calls, catalog refreshes and web-search providers.

For `rate_limited`, `rejected`, `auth`, `upstream` and `network` the latest 20 samples per upstream and status keep the upstream's error code and message (at most 300 characters, token-looking strings redacted; HTML or unparsable bodies store an empty message; transport failures store the error name). Only the upstream's error description is stored, never the request or response content as such; a plain-text error body may still echo parts of the request, which is why messages are redacted and trimmed to 300 characters.

## Protection settings (per upstream, default off)

Set in the dashboard (Upstreams, Protection button) or with `PATCH /api/upstreams/:id` and a `protection` object (missing fields keep their stored values). Synced upstreams may edit it; statistics and protection are local to each gateway.

| field | default | range | meaning |
| --- | --- | --- | --- |
| `mode` | `off` | `off`, `notify`, `pause` | off records only; notify raises a warning; pause also blocks |
| `windowMinutes` | 5 | 1 to 60 | whole minutes counted, including the current one |
| `minRiskyErrors` | 20 | 1 to 10000 | risky errors needed |
| `minFailureRatio` | 0.5 | 0 to 1 | risky errors / requests in the window |
| `authBurst` | 5 | 0 to 10000 | auth errors alone that trigger; 0 disables |
| `keyShare` | 0.8 | 0.5 to 1 | share of the risky errors that attributes them to one key |
| `cooldownMinutes` | 30 | 1 to 1440 | length of a pause or warning |
| `maxCooldownMinutes` | 360 | 1 to 10080, not below `cooldownMinutes` | cap of the doubling |

## Detection

After a risky response is recorded (at most once every 10 s per upstream per isolate) the gateway sums the window. It triggers when `risky >= minRiskyErrors and risky / requests >= minFailureRatio`, or when `authBurst > 0 and auth >= authBurst`. If one key caused at least `keyShare` of the risky errors and at least two distinct API keys sent requests in the window, the target is that key (on every upstream); otherwise it is the upstream, so a single-key setup is never locked out of its own upstream through the key. Requests without an API key are never attributed to a key and do not count as a second key. After the owner resumes a pause or warning of the upstream or one of its keys, errors up to and including the resume minute are ignored, so the target is not paused again by the same errors. An auth rejection (401/403) that the provider cured by refreshing its credential and replaying the request counts as `other`, not `auth`; a final 401/403 and a Codex `token_invalidated` still count as `auth`.

The cooldown is `cooldownMinutes`, doubled for each earlier row of the same target and mode that started in the last 24 hours, capped at `maxCooldownMinutes`. No second row is created while one covers the target: in `notify` mode any active row covers, in `pause` mode only an active `pause` row does (a notify warning does not stop a pause after the mode is raised).

## Enforcement and errors

- `notify` rows only warn (dashboard banner); nothing is blocked.
- A paused upstream is skipped during routing like an unavailable one. If every candidate that would serve the request is paused the answer is `503` with `Retry-After` and error code `upstream_paused` (Gemini keeps its Google error body and gets the header only). Embeddings and images answer the same 503. Model listings still show the paused upstream's models. With a session affinity, `upstream_paused` is reported only when a paused candidate would have been authorized; otherwise the normal affinity error applies. When a paused upstream and a failed catalog are both possible causes, `upstream_paused` wins.
- A paused key gets `503`, code `key_paused` and `Retry-After` before any upstream is called. The guard applies to inference paths only (chat, messages, responses, Gemini, Ollama, embeddings, images, models, `alpha/search`, `decisions`, `systemone`, `count_tokens`); dashboard and control-plane routes stay open, and dashboard sessions are not checked.
- The `key_paused` body follows the protocol of the path (Anthropic shape on `/v1/messages` and `count_tokens`, Google RPC shape on Gemini paths, OpenAI shape elsewhere), always with `Retry-After`. `decisions` and `systemone` now run under the config snapshot, like the other inference routes.
- `Retry-After` is the whole seconds until the earliest resume, at least 1.
- Enforcement uses a per-isolate cache of active pauses (10 s TTL, stale-while-revalidate: a stale cache answers at once and refreshes in the background; only a cold cache waits). The isolate that creates or resumes a pause updates its own cache immediately; others follow within about 10 s. If a refresh fails the previous state stays in force (fail-open).

## API (browser session, owner-only; admins see everything)

- `GET /api/protection/active`: active pauses and warnings the caller may see.
- `POST /api/protection/pauses/:id/resume`: a key pause may be resumed by the key's owner or an admin, an upstream pause by that upstream's owner or an admin; others get 404. Resuming a `notify` row dismisses the warning.
- `GET /api/upstreams/:id/errors?from=&to=&bucket=minute|hour&keyId=`: `from`/`to` unix seconds (default last hour), at most 30 days and 1500 buckets, sparse buckets. `bucket` defaults to `minute` if the range, aligned to whole minutes, fits 1500 minutes, else `hour`. The filter is `keyId`, not `key`, because the session guard refuses a `key` query parameter.
- `GET /api/upstreams/:id/error-samples`, `GET /api/upstreams/:id/pauses?limit=` (1 to 100, default 20).

A viewer who owns the affected key but not the upstream sees the pause with blank upstream id and name and only their own keys in `reason.topKeys`.

## Dashboard

A global banner lists active pauses and warnings; each upstream has a collapsible Protection section (settings, error chart, recent samples, pause history); a paused API key shows a badge with the reason and a Resume button when permitted. The store polls every 60 s and after actions, and pauses polling while the page is hidden (one refresh when it is shown again).

## Retention

The scheduled maintenance sweep deletes per-minute counts older than 30 days and pause rows older than 90 days, and stamps expired rows `resolved_by = 'auto'`. Samples and settings of vanished upstreams are removed by orphan scans that run hourly (UTC minute 17) and again while the previous scan filled a chunk. Deletes run in chunks of 5000 rows, at most 10 per table per sweep.

## Limitations

- Unrecorded call types listed above, so an account can be hit by traffic the protection cannot see or stop.
- Classification is by status at response headers; mid-stream failures are `ok`. Any `TypeError` from fetch counts as `network`.
- Counts and caches are per isolate; enforcement lags up to about 10 s on other isolates.

## Rollout

Merge, push, apply migration `0027_upstream_protection.sql` to D1, deploy the Worker, rebuild local gateways. Statistics start immediately; protection stays `off` until enabled per upstream.
